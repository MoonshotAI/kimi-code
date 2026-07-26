/// CronScheduler — the scheduling engine.
///
/// This is the bottom of the cron stack: it knows about tasks, clocks,
/// jitter, and "is the agent idle?", but nothing about agents, tools,
/// persistence, or the file system. Persistence is layered on top by
/// `CronManager`.
///
/// Design notes:
///
/// - **No direct wall-clock reads.** Every wall-clock read goes through
///   `clocks.wall_now()`.
///
/// - **`source()` is called every tick.** It returns the *current* task
///   list. Callers typically wire it to `store.list()`, so creating /
///   deleting tasks between ticks is picked up automatically.
///
/// - **`is_idle()` gates fires, not state updates.** When the agent is
///   mid-turn we skip firing — but we do NOT advance `last_seen_at`.
///   The next idle tick will see the tasks as still due and fire them,
///   with `coalesced_count` reflecting the gap.
///
/// - **`coalesced_count` semantics.** When a sleep / busy turn causes
///   the scheduler to miss multiple ideal fires, we deliver exactly ONE
///   `on_fire` call and tell the caller how many ideal fires we collapsed
///   into it. Floor at 1.
///
/// - **Bad tasks do not poison the loop.** Each task's processing is
///   wrapped in try/catch so one busted cron expression cannot starve
///   the other tasks.

use std::collections::{HashMap, HashSet};

use crate::cron::clock::ClockSources;
use crate::cron::expr::{compute_next_cron_run, parse_cron_expression};
use crate::cron::jitter::{jittered_next_cron_run_ms, one_shot_jittered_next_cron_run_ms};
use crate::cron::types::{CronTask, JitterConfig, ParsedCronExpression};

/// Cap on how many ideal fires we attempt to enumerate when computing
/// coalesced_count. With a 1-minute cron, this still covers 10 000
/// minutes (~7 days).
const MAX_COALESCE_ITERATIONS: u32 = 10_000;

/// Options for creating a CronScheduler.
pub struct CronSchedulerOptions {
    /// Required. Wall + monotonic clock source.
    pub clocks: ClockSources,

    /// Required. Returns the live task list. Called every tick — keep cheap.
    pub source: Box<dyn Fn() -> Vec<CronTask> + Send + Sync>,

    /// Required. Called when a task fires.
    pub on_fire: Box<dyn Fn(&CronTask, u32) + Send + Sync>,

    /// Required. Returns true when the agent is idle.
    pub is_idle: Box<dyn Fn() -> bool + Send + Sync>,

    /// Optional. Returns true when the global killswitch is on.
    pub is_killed: Option<Box<dyn Fn() -> bool + Send + Sync>>,

    /// Optional. Called when a one-shot task fires and must be removed.
    pub remove_one_shot: Option<Box<dyn Fn(&str) + Send + Sync>>,

    /// Optional. Called after a recurring task fires, with the wall-clock
    /// timestamp of the last ideal occurrence.
    pub on_advance_cursor: Option<Box<dyn Fn(&str, u64) + Send + Sync>>,

    /// Optional. Poll interval in ms. Default 1000.
    pub poll_interval_ms: Option<u64>,

    /// Optional. Jitter config.
    pub jitter_config: Option<JitterConfig>,
}

/// The CronScheduler instance.
pub struct CronScheduler {
    opts: CronSchedulerOptions,
    jitter_config: JitterConfig,
    /// Cached parsed cron expressions
    parsed_cache: HashMap<String, ParsedCronExpression>,
    /// Per-task wall-clock baseline
    last_seen_at: HashMap<String, u64>,
    /// Tracks which task ids have already had `last_fired_at` consulted
    seeded_from_disk: HashSet<String>,
    /// Set of task ids currently in-flight (re-entrancy guard)
    in_flight: HashSet<String>,
}

impl CronScheduler {
    /// Create a new scheduler.
    pub fn new(opts: CronSchedulerOptions) -> Self {
        let jitter_config = opts.jitter_config.unwrap_or_default();
        Self {
            opts,
            jitter_config,
            parsed_cache: HashMap::new(),
            last_seen_at: HashMap::new(),
            seeded_from_disk: HashSet::new(),
            in_flight: HashSet::new(),
        }
    }

    /// Get or parse a cron expression.
    fn get_parsed(&mut self, expr: &str) -> Result<&ParsedCronExpression, String> {
        if !self.parsed_cache.contains_key(expr) {
            let parsed = parse_cron_expression(expr)?;
            self.parsed_cache.insert(expr.to_string(), parsed);
        }
        // Safe: we just inserted if not present
        Ok(self.parsed_cache.get(expr).unwrap())
    }

    /// Compute the jittered next-fire for a task, starting from `base_ms`.
    fn compute_jittered_next(
        &mut self,
        task: &CronTask,
        parsed: &ParsedCronExpression,
        base_ms: u64,
    ) -> Option<u64> {
        let ideal = compute_next_cron_run(parsed, base_ms)?;
        if task.is_one_shot() {
            Some(one_shot_jittered_next_cron_run_ms(
                &task.id,
                ideal,
                Some(task.created_at),
                &self.jitter_config,
            ))
        } else {
            Some(jittered_next_cron_run_ms(
                &task.id,
                &task.cron,
                parsed,
                ideal,
                &self.jitter_config,
            ))
        }
    }

    /// Count how many ideal fires fall in `(first_fire_ms, now_ms]` whose
    /// **jittered delivery time** is also ≤ `now_ms`.
    fn count_coalesced(
        &mut self,
        task: &CronTask,
        parsed: &ParsedCronExpression,
        first_fire_ms: u64,
        now_ms: u64,
    ) -> (u32, u64) {
        let mut count: u32 = 1;
        let mut cursor = first_fire_ms;
        let mut last_due_ms = first_fire_ms;

        while count < MAX_COALESCE_ITERATIONS {
            let next = match compute_next_cron_run(parsed, cursor) {
                Some(n) if n <= now_ms => n,
                _ => break,
            };

            let jittered_next = if task.is_one_shot() {
                one_shot_jittered_next_cron_run_ms(&task.id, next, Some(task.created_at), &self.jitter_config)
            } else {
                jittered_next_cron_run_ms(&task.id, &task.cron, parsed, next, &self.jitter_config)
            };

            if jittered_next > now_ms {
                break;
            }

            count += 1;
            cursor = next;
            last_due_ms = next;
        }

        (count, last_due_ms)
    }

    /// Run one check cycle. Processes all current tasks.
    pub fn tick(&mut self) {
        // Killswitch check
        if let Some(ref is_killed) = self.opts.is_killed {
            if is_killed() {
                return;
            }
        }

        // Idle check
        if !(self.opts.is_idle)() {
            return;
        }

        let tasks = (self.opts.source)();
        if tasks.is_empty() {
            return;
        }

        let now = (self.opts.clocks.wall_now)();

        for task in &tasks {
            if self.in_flight.contains(&task.id) {
                continue;
            }

            let parsed = match self.get_parsed(&task.cron) {
                Ok(p) => p.clone(),
                Err(_) => continue,
            };

            // First time we see this task in this scheduler instance,
            // seed `last_seen_at` from the persisted `task.last_fired_at`
            if !self.seeded_from_disk.contains(&task.id)
                && task.last_fired_at.is_some()
                && task.last_fired_at.unwrap() <= now
                && !self.last_seen_at.contains_key(&task.id)
            {
                self.last_seen_at.insert(task.id.clone(), task.last_fired_at.unwrap());
            }
            self.seeded_from_disk.insert(task.id.clone());

            let seen = self.last_seen_at.get(&task.id).copied();
            let base_from_ms = match seen {
                Some(s) if s > task.created_at => s,
                _ => task.created_at,
            };

            let next_fire_at = match self.compute_jittered_next(task, &parsed, base_from_ms) {
                Some(n) => n,
                None => continue,
            };

            if now < next_fire_at {
                continue;
            }

            // Compute coalesced count
            let ideal = compute_next_cron_run(&parsed, base_from_ms);
            let (coalesced_count, last_due_ms) = if task.is_recurring() {
                if let Some(ideal) = ideal {
                    self.count_coalesced(task, &parsed, ideal, now)
                } else {
                    (1, now)
                }
            } else {
                (1, now)
            };

            let coalesced_count = std::cmp::max(1, coalesced_count);

            self.in_flight.insert(task.id.clone());

            (self.opts.on_fire)(task, coalesced_count);

            if task.is_one_shot() {
                if let Some(ref remove) = self.opts.remove_one_shot {
                    remove(&task.id);
                }
                self.last_seen_at.remove(&task.id);
                self.seeded_from_disk.remove(&task.id);
            } else {
                let advanced_to = last_due_ms;
                self.last_seen_at.insert(task.id.clone(), advanced_to);
                if let Some(ref advance) = self.opts.on_advance_cursor {
                    advance(&task.id, advanced_to);
                }
            }
        }

        self.in_flight.clear();
    }

    /// Get the next fire time for a specific task.
    pub fn get_next_fire_for_task(&mut self, task_id: &str) -> Option<u64> {
        let tasks = (self.opts.source)();
        let task = tasks.iter().find(|t| t.id == task_id)?;
        self.next_fire_for(task)
    }

    /// Earliest next fire across all tasks.
    pub fn get_next_fire_time(&mut self) -> Option<u64> {
        let tasks = (self.opts.source)();
        let mut min: Option<u64> = None;
        for task in &tasks {
            if let Some(next) = self.next_fire_for(task) {
                match min {
                    None => min = Some(next),
                    Some(m) if next < m => min = Some(next),
                    _ => {}
                }
            }
        }
        min
    }

    fn next_fire_for(&mut self, task: &CronTask) -> Option<u64> {
        let parsed = match self.get_parsed(&task.cron) {
            Ok(p) => p.clone(),
            Err(_) => return None,
        };

        let seen = self.last_seen_at.get(&task.id).copied();

        // Mirror tick()'s seeding
        let persisted_cursor = task.last_fired_at.filter(|&lfa| lfa <= (self.opts.clocks.wall_now)());

        let cursor = seen.or(persisted_cursor);

        let base_from_ms = match cursor {
            Some(c) if c > task.created_at => c,
            _ => task.created_at,
        };

        self.compute_jittered_next(task, &parsed, base_from_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn test_empty_tick() {
        let mut scheduler = CronScheduler::new(CronSchedulerOptions {
            clocks: ClockSources::system(),
            source: Box::new(|| vec![]),
            on_fire: Box::new(|_, _| {}),
            is_idle: Box::new(|| true),
            is_killed: None,
            remove_one_shot: None,
            on_advance_cursor: None,
            poll_interval_ms: None,
            jitter_config: None,
        });
        scheduler.tick(); // should not panic
    }

    #[test]
    fn test_basic_tick() {
        let fired = Arc::new(std::sync::Mutex::new(Vec::new()));
        let fired_clone = fired.clone();

        let mut store = super::super::store::SessionCronStore::new();
        // Add a task that fires every minute
        let task = store.add(
            crate::cron::types::CronTaskInit {
                cron: "* * * * *".into(),
                prompt: "every minute".into(),
                recurring: None,
            },
            0, // created at t=0
        );

        let mut scheduler = CronScheduler::new(CronSchedulerOptions {
            clocks: ClockSources::test(61000), // now = 61s (> 1 min, so it should fire)
            source: Box::new(move || store.list()),
            on_fire: Box::new(move |t, count| {
                fired_clone.lock().unwrap().push((t.id.clone(), count));
            }),
            is_idle: Box::new(|| true),
            is_killed: None,
            remove_one_shot: None,
            on_advance_cursor: None,
            poll_interval_ms: None,
            jitter_config: Some(JitterConfig {
                recurring_max_fraction_of_period: 0.0, // disable jitter for test
                recurring_max_ms: 0,
                one_shot_max_ms: 0,
            }),
        });

        scheduler.tick();
        let fired = fired.lock().unwrap();
        assert_eq!(fired.len(), 1, "should have fired once");
        assert_eq!(fired[0].0, task.id);
    }

    #[test]
    fn test_not_idle_skips_fire() {
        let fired = Arc::new(std::sync::Mutex::new(0));
        let fired_clone = fired.clone();

        let mut store = super::super::store::SessionCronStore::new();
        store.add(
            crate::cron::types::CronTaskInit {
                cron: "* * * * *".into(),
                prompt: "test".into(),
                recurring: None,
            },
            1000,
        );

        let mut scheduler = CronScheduler::new(CronSchedulerOptions {
            clocks: ClockSources::test(2000),
            source: Box::new(move || store.list()),
            on_fire: Box::new(move |_, _| {
                *fired_clone.lock().unwrap() += 1;
            }),
            is_idle: Box::new(|| false), // NOT idle
            is_killed: None,
            remove_one_shot: None,
            on_advance_cursor: None,
            poll_interval_ms: None,
            jitter_config: Some(JitterConfig {
                recurring_max_fraction_of_period: 0.0,
                recurring_max_ms: 0,
                one_shot_max_ms: 0,
            }),
        });

        scheduler.tick();
        assert_eq!(*fired.lock().unwrap(), 0, "should not fire when not idle");
    }

    #[test]
    fn test_get_next_fire_time() {
        let mut store = super::super::store::SessionCronStore::new();
        let jan15_2024_08_00 = 1705305600000u64;

        store.add(
            crate::cron::types::CronTaskInit {
                cron: "0 9 * * *".into(),
                prompt: "daily at 9".into(),
                recurring: None,
            },
            jan15_2024_08_00, // created_at matches clock time
        );

        let jan15_2024_9am = 1705309200000u64;

        let mut scheduler = CronScheduler::new(CronSchedulerOptions {
            clocks: ClockSources::test(jan15_2024_08_00),
            source: Box::new(move || store.list()),
            on_fire: Box::new(|_, _| {}),
            is_idle: Box::new(|| true),
            is_killed: None,
            remove_one_shot: None,
            on_advance_cursor: None,
            poll_interval_ms: None,
            jitter_config: Some(JitterConfig {
                recurring_max_fraction_of_period: 0.0,
                recurring_max_ms: 0,
                one_shot_max_ms: 0,
            }),
        });

        let next = scheduler.get_next_fire_time();
        assert!(next.is_some(), "should have a next fire time");
        let next_val = next.unwrap();
        // Should be 09:00
        assert_eq!(next_val, jan15_2024_9am);
    }
}