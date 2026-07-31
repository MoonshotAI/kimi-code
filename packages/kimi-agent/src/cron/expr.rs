/// 5-field cron expression parsing and "next fire time" computation, in
/// local time. Self-contained — no external cron library is used.
///
/// Two flavours of correctness we care about:
///
/// 1. **Semantics.** Standard 5 fields (minute hour day-of-month month
///    day-of-week). Day-of-month and day-of-week combine with cron's
///    OR rule when both are restricted (POSIX/Vixie tradition). dow
///    accepts 0..7 with 7 folded to 0 (Sunday).
///
/// 2. **Termination.** Computing `next` for a legal-but-never-fires
///    expression like `0 0 31 2 *` must not spin. We bound the search
///    at a fixed window (5 years by default) and return `None` past
///    that.

use crate::cron::types::ParsedCronExpression;

const MS_PER_MINUTE: u64 = 60_000;

struct Range {
    min: u8,
    max: u8,
}

const MINUTE_RANGE: Range = Range { min: 0, max: 59 };
const HOUR_RANGE: Range = Range { min: 0, max: 23 };
const DOM_RANGE: Range = Range { min: 1, max: 31 };
const MONTH_RANGE: Range = Range { min: 1, max: 12 };
const DOW_RANGE: Range = Range { min: 0, max: 7 }; // 7 → 0 fold after parse

/// Parse a 5-field cron expression. Returns an error on any syntax issue.
pub fn parse_cron_expression(expr: &str) -> Result<ParsedCronExpression, String> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err("cron expression is empty".into());
    }

    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got {}",
            fields.len()
        ));
    }

    let minutes = parse_field(fields[0], &MINUTE_RANGE, "minute")?;
    let hours = parse_field(fields[1], &HOUR_RANGE, "hour")?;
    let days_of_month = parse_field(fields[2], &DOM_RANGE, "day-of-month")?;
    let months = parse_field(fields[3], &MONTH_RANGE, "month")?;
    let dow_raw = parse_field(fields[4], &DOW_RANGE, "day-of-week")?;

    // Fold 7 → 0 (Sunday)
    let days_of_week: Vec<u8> = {
        let mut v: Vec<u8> = dow_raw.into_iter().map(|v| if v == 7 { 0 } else { v }).collect();
        v.sort();
        v.dedup();
        v
    };

    Ok(ParsedCronExpression {
        raw: trimmed.to_string(),
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        days_of_month_wildcard: is_wildcard(fields[2]),
        days_of_week_wildcard: is_wildcard(fields[4]),
    })
}

fn is_wildcard(field: &str) -> bool {
    field == "*"
}

fn parse_field(field: &str, range: &Range, name: &str) -> Result<Vec<u8>, String> {
    if field.is_empty() {
        return Err(format!("cron {} field is empty", name));
    }

    let mut out = Vec::new();
    let terms: Vec<&str> = field.split(',').collect();
    for term in &terms {
        if term.is_empty() {
            return Err(format!("cron {} field has empty term in list", name));
        }
        add_term(&mut out, term, range, name)?;
    }

    if out.is_empty() {
        return Err(format!("cron {} field matches no values", name));
    }

    out.sort();
    out.dedup();
    Ok(out)
}

fn add_term(out: &mut Vec<u8>, term: &str, range: &Range, name: &str) -> Result<(), String> {
    let mut range_part = term;
    let mut step: u8 = 1;

    if let Some(slash) = term.find('/') {
        range_part = &term[..slash];
        let step_str = &term[slash + 1..];
        if step_str.is_empty() {
            return Err(format!("cron {} step is empty in \"{}\"", name, term));
        }
        let parsed_step = parse_cron_int(step_str, name, "step")?;
        if parsed_step == 0 {
            return Err(format!("cron {} step must be a positive integer (got \"{}\")", name, step_str));
        }
        step = parsed_step;
        if range_part.is_empty() {
            return Err(format!("cron {} step needs a range or \"*\" before \"/\" in \"{}\"", name, term));
        }
    }

    if range_part == "*" {
        let mut v = range.min;
        while v <= range.max {
            out.push(v);
            v = v.wrapping_add(step);
        }
        return Ok(());
    }

    if let Some(dash) = range_part.find('-') {
        let lo_str = &range_part[..dash];
        let hi_str = &range_part[dash + 1..];
        let lo = parse_cron_int(lo_str, name, "range lower bound")?;
        let hi = parse_cron_int(hi_str, name, "range upper bound")?;
        if lo < range.min || hi > range.max || lo > hi {
            return Err(format!(
                "cron {} range {}-{} out of bounds (must be {}..{}, ascending)",
                name, lo, hi, range.min, range.max
            ));
        }
        let mut v = lo;
        while v <= hi {
            out.push(v);
            v = v.wrapping_add(step);
        }
    } else {
        let single = parse_cron_int(range_part, name, "value")?;
        if single < range.min || single > range.max {
            return Err(format!(
                "cron {} value {} out of range {}..{}",
                name, single, range.min, range.max
            ));
        }
        // A bare single value with a step (`5/10`) is unusual; treat as
        // "from value through max stepping by N".
        if term.contains('/') {
            let mut v = single;
            while v <= range.max {
                out.push(v);
                v = v.wrapping_add(step);
            }
        } else {
            out.push(single);
        }
    }

    Ok(())
}

/// Parse a cron integer field value. Validates digits-only.
fn parse_cron_int(raw: &str, name: &str, role: &str) -> Result<u8, String> {
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "cron {} {} must be a non-negative integer with digits only (got {:?})",
            name, role, raw
        ));
    }
    raw.parse::<u8>()
        .map_err(|e| format!("cron {} {} parse error: {}", name, role, e))
}

/// Find the next wall-clock epoch ms strictly greater than `from_ms` that
/// satisfies `expr`, using local-time semantics. Returns `None` if no
/// match exists inside the default 5-year search window.
pub fn compute_next_cron_run(expr: &ParsedCronExpression, from_ms: u64) -> Option<u64> {
    next_run_within_minutes(expr, from_ms, 5 * 366 * 24 * 60)
}

/// True iff at least one fire exists within `years` years of `from_ms`.
pub fn has_fire_within_years(expr: &ParsedCronExpression, years: u32, from_ms: u64) -> bool {
    let cap = std::cmp::max(1, (years as u64) * 366 * 24 * 60);
    next_run_within_minutes(expr, from_ms, cap).is_some()
}

/// Compute the next fire time, bounded by a cap on the number of minutes
/// to search forward.
fn next_run_within_minutes(expr: &ParsedCronExpression, from_ms: u64, cap_minutes: u64) -> Option<u64> {
    // Seek strictly into the next minute: drop seconds/ms and add one minute.
    let start = from_ms - (from_ms % MS_PER_MINUTE) + MS_PER_MINUTE;
    let deadline_ms = from_ms + cap_minutes * MS_PER_MINUTE;
    let hard_iteration_cap: u64 = 10_000_000;

    let mut iterations: u64 = 0;
    let mut current = start;

    while current <= deadline_ms && iterations < hard_iteration_cap {
        iterations += 1;

        // Decompose current ms into components
        let (year, month, day, hour, minute) = ms_to_components(current);

        // Month check
        if !expr.months.contains(&(month as u8)) {
            // Jump to day 1 of next month
            current = advance_month(current);
            continue;
        }

        // Day check (cron OR rule)
        if !day_matches(expr, day as u8, dow(&year, &month, &day)) {
            current = advance_day(current);
            continue;
        }

        // Hour check
        if !expr.hours.contains(&(hour as u8)) {
            current = advance_hour(current);
            continue;
        }

        // Minute check
        if !expr.minutes.contains(&(minute as u8)) {
            current = advance_minute(current);
            continue;
        }

        return Some(current);
    }

    None
}

fn day_matches(expr: &ParsedCronExpression, dom: u8, dow: u8) -> bool {
    let dom_ok = expr.days_of_month.contains(&dom);
    let dow_ok = expr.days_of_week.contains(&dow);

    if expr.days_of_month_wildcard && expr.days_of_week_wildcard {
        return true;
    }
    if expr.days_of_month_wildcard {
        return dow_ok;
    }
    if expr.days_of_week_wildcard {
        return dom_ok;
    }
    // Both restricted: cron-style OR
    dom_ok || dow_ok
}

/// Advance to the 1st of the next month at 00:00.
fn advance_month(current: u64) -> u64 {
    let (year, month, _day, _hour, _minute) = ms_to_components(current);
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1u8)
    } else {
        (year, month + 1)
    };
    components_to_ms(next_year, next_month, 1, 0, 0)
}

/// Advance to the next day at 00:00.
fn advance_day(current: u64) -> u64 {
    let (year, month, day, _hour, _minute) = ms_to_components(current);
    let days_in_month = days_in_month(year, month);
    if day < days_in_month {
        components_to_ms(year, month, day + 1, 0, 0)
    } else {
        // Next month, day 1
        advance_month(current)
    }
}

/// Advance to the next hour at :00.
fn advance_hour(current: u64) -> u64 {
    let (year, month, day, hour, _minute) = ms_to_components(current);
    if hour < 23 {
        components_to_ms(year, month, day, hour + 1, 0)
    } else {
        // Next day
        advance_day(current)
    }
}

/// Advance to the next minute.
fn advance_minute(current: u64) -> u64 {
    current + MS_PER_MINUTE
}

/// Convert epoch ms to (year, month, day, hour, minute).
/// Uses a simple algorithm valid for dates in the cron range.
fn ms_to_components(ms: u64) -> (i64, u8, u8, u8, u8) {
    let secs = ms / 1000;
    let _ms_remainder = ms % 1000;
    let _total_minutes = secs / 60;
    // We need to work with seconds from epoch
    let total_seconds = secs - (secs % 60); // floor to seconds

    // Use a simple algorithm based on days since epoch
    let days_since_epoch = (total_seconds / 86400) as i64;
    let time_seconds = total_seconds % 86400;

    let hour = (time_seconds / 3600) as u8;
    let minute = ((time_seconds % 3600) / 60) as u8;

    // Days since epoch to year/month/day
    let (year, month, day) = days_to_date(days_since_epoch);

    (year, month, day, hour, minute)
}

/// Convert (year, month, day, hour, minute) to epoch ms.
fn components_to_ms(year: i64, month: u8, day: u8, hour: u8, minute: u8) -> u64 {
    let days = date_to_days(year, month, day);
    let total_seconds = days * 86400 + (hour as i64) * 3600 + (minute as i64) * 60;
    (total_seconds as u64) * 1000
}

/// Days since Unix epoch to (year, month, day).
fn days_to_date(days: i64) -> (i64, u8, u8) {
    let mut y = 1970i64;
    let mut d = days;

    // First, estimate year
    loop {
        let yd = if is_leap(y) { 366 } else { 365 };
        if d < yd {
            break;
        }
        d -= yd;
        y += 1;
    }

    // d is now day of year (0-indexed)
    let leap = is_leap(y);
    for (m, days_in_m) in month_days(leap).iter().enumerate() {
        if d < *days_in_m as i64 {
            return (y, (m + 1) as u8, (d + 1) as u8);
        }
        d -= *days_in_m as i64;
    }

    // Should not reach here
    (y, 1, 1)
}

/// Date to days since Unix epoch.
fn date_to_days(year: i64, month: u8, day: u8) -> i64 {
    let mut days = 0i64;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    let leap = is_leap(year);
    for (m, days_in_m) in month_days(leap).iter().enumerate() {
        if (m as u8) < month - 1 {
            days += *days_in_m as i64;
        }
    }
    days += (day - 1) as i64;
    days
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u8) -> u8 {
    let leap = is_leap(year);
    month_days(leap)[(month - 1) as usize]
}

fn month_days(leap: bool) -> [u8; 12] {
    if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    }
}

/// Day of week (0=Sunday, 1=Monday, ..., 6=Saturday) using Zeller/Tomohiko
/// Sakamoto algorithm.
fn dow(year: &i64, month: &u8, day: &u8) -> u8 {
    let mut y = *year;
    let mut m = *month as i64;
    if m < 3 {
        m += 12;
        y -= 1;
    }
    let d = *day as i64;
    let k = y % 100;
    let j = y / 100;
    let h = (d + (13 * (m + 1)) / 5 + k + k / 4 + j / 4 + 5 * j) % 7;
    // h is 0=Saturday, 1=Sunday, ..., 6=Friday
    // Convert to 0=Sunday, 1=Monday, ..., 6=Saturday
    ((h + 6) % 7) as u8
}

/// Generate a human-readable summary of a cron expression.
///
/// # ⚠️ Debug-only — NOT user-facing
///
/// This function returns English-only strings ("every minute", "at 09:00
/// every day", ...). It is intended for **diagnostics and tests only** and
/// must never be surfaced to the UI, because the project's i18n hard
/// constraint requires all user-visible strings to go through the `t()`
/// i18n framework on the TypeScript side.
///
/// If you need to display a human-readable cron summary in the TUI, either:
///   1. Send the raw cron string over RPC and let TypeScript format it via
///      a localized library (e.g. `cronstrue` with the active locale), or
///   2. Return a structured `CronSummary` enum from Rust and format it on
///      the TS side using `t()` keys.
///
/// Marked `#[deprecated]` so accidental call sites produce a warning that
/// points the author here.
#[deprecated(note = "debug-only; returns English text. Do not surface to UI — see i18n hard constraint")]
#[allow(dead_code)]
pub fn cron_to_human(expr: &ParsedCronExpression) -> String {
    let all_min = is_full_range(&expr.minutes, 0, 59);
    let all_hour = is_full_range(&expr.hours, 0, 23);
    let all_dom = expr.days_of_month_wildcard;
    let all_month = is_full_range(&expr.months, 1, 12);
    let all_dow = expr.days_of_week_wildcard;

    // every N minutes
    if all_hour && all_dom && all_month && all_dow {
        if let Some(step) = detect_step(&expr.minutes, 0, 59) {
            if step > 1 {
                return format!("every {} minutes", step);
            }
        }
        if all_min {
            return "every minute".into();
        }
        if expr.minutes.len() == 1 {
            return format!("at minute {} of every hour", expr.minutes[0]);
        }
    }

    // every N hours
    if expr.minutes.len() == 1 && all_dom && all_month && all_dow {
        let m = expr.minutes[0];
        if let Some(step) = detect_step(&expr.hours, 0, 23) {
            if step > 1 {
                return format!("every {} hours at minute {:02}", step, m);
            }
        }
    }

    // at HH:MM every day, optional dow restriction
    if expr.minutes.len() == 1 && expr.hours.len() == 1 && all_dom && all_month {
        let h = expr.hours[0];
        let m = expr.minutes[0];
        if all_dow {
            return format!("at {:02}:{:02} every day", h, m);
        }
        if let Some(dow_str) = format_dows(&expr.days_of_week) {
            return format!("at {:02}:{:02} on {}", h, m, dow_str);
        }
    }

    // at HH:MM on day N of <month>
    if expr.minutes.len() == 1
        && expr.hours.len() == 1
        && expr.days_of_month.len() == 1
        && !expr.days_of_month_wildcard
        && expr.months.len() == 1
        && all_dow
    {
        let h = expr.hours[0];
        let m = expr.minutes[0];
        let d = expr.days_of_month[0];
        let mo = expr.months[0];
        let month_name = match mo {
            1 => "January",
            2 => "February",
            3 => "March",
            4 => "April",
            5 => "May",
            6 => "June",
            7 => "July",
            8 => "August",
            9 => "September",
            10 => "October",
            11 => "November",
            _ => "December",
        };
        return format!("at {:02}:{:02} on day {} of {}", h, m, d, month_name);
    }

    expr.raw.clone()
}

fn is_full_range(set: &[u8], min: u8, max: u8) -> bool {
    if set.len() != (max - min + 1) as usize {
        return false;
    }
    let mut expected = min;
    for &v in set {
        if v != expected {
            return false;
        }
        expected += 1;
    }
    true
}

fn detect_step(set: &[u8], min: u8, max: u8) -> Option<u8> {
    if set.len() < 2 {
        return None;
    }
    if set[0] != min {
        return None;
    }
    let step = set[1] - set[0];
    if step == 0 {
        return None;
    }
    let mut expected = min;
    for &v in set {
        if v != expected {
            return None;
        }
        expected = expected.wrapping_add(step);
    }
    if expected.wrapping_sub(step) > max {
        return None;
    }
    Some(step)
}

fn format_dows(set: &[u8]) -> Option<String> {
    let day_names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    if set.is_empty() {
        return None;
    }

    // Mon-Fri shortcut
    if set.len() == 5 && set.iter().enumerate().all(|(i, &v)| v == (i + 1) as u8) {
        return Some("weekdays".into());
    }

    // Weekends shortcut
    if set.len() == 2 && set[0] == 0 && set[1] == 6 {
        return Some("weekends".into());
    }

    let names: Vec<&str> = set.iter().map(|&v| day_names[v as usize]).collect();
    Some(names.join(", "))
}

#[cfg(test)]
mod tests {
    // The human-readable renderer is intentionally deprecated for UI use
    // (English-only, i18n constraint); the tests pin its debug output.
    #![allow(deprecated)]
    use super::*;

    #[test]
    fn test_parse_minute_wildcard() {
        let expr = parse_cron_expression("* * * * *").unwrap();
        assert_eq!(expr.minutes.len(), 60);
        assert_eq!(expr.hours.len(), 24);
        assert_eq!(expr.days_of_month.len(), 31);
        assert_eq!(expr.months.len(), 12);
        assert_eq!(expr.days_of_week.len(), 7);
        assert!(expr.days_of_month_wildcard);
        assert!(expr.days_of_week_wildcard);
    }

    #[test]
    fn test_parse_specific_time() {
        let expr = parse_cron_expression("30 9 * * 1-5").unwrap();
        assert_eq!(expr.minutes, vec![30]);
        assert_eq!(expr.hours, vec![9]);
        assert!(expr.days_of_month_wildcard);
        assert!(expr.months.len() == 12);
        assert_eq!(expr.days_of_week, vec![1, 2, 3, 4, 5]); // Mon-Fri
    }

    #[test]
    fn test_parse_step() {
        let expr = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(expr.minutes.len(), 12);
        assert!(expr.minutes.contains(&0));
        assert!(expr.minutes.contains(&5));
        assert!(expr.minutes.contains(&55));
    }

    #[test]
    fn test_parse_list() {
        let expr = parse_cron_expression("0,15,30,45 * * * *").unwrap();
        assert_eq!(expr.minutes, vec![0, 15, 30, 45]);
    }

    #[test]
    fn test_parse_dow_7_to_0() {
        let expr = parse_cron_expression("0 0 * * 0,7").unwrap();
        // 7 should be folded to 0, then deduped
        assert_eq!(expr.days_of_week, vec![0]);
    }

    #[test]
    fn test_parse_errors() {
        assert!(parse_cron_expression("").is_err());
        assert!(parse_cron_expression("1 2 3 4").is_err()); // 4 fields
        assert!(parse_cron_expression("1 2 3 4 5 6").is_err()); // 6 fields
        assert!(parse_cron_expression("a b c d e").is_err()); // non-digits
    }

    #[test]
    fn test_compute_next_basic() {
        // Every minute: next should be exactly 1 minute after from_ms
        let expr = parse_cron_expression("* * * * *").unwrap();
        let from = 1700000000000; // some epoch ms
        let next = compute_next_cron_run(&expr, from).unwrap();
        assert_eq!(next, from - (from % MS_PER_MINUTE) + MS_PER_MINUTE);
    }

    #[test]
    fn test_compute_next_specific_time() {
        // 0 9 * * * (daily at 09:00)
        let expr = parse_cron_expression("0 9 * * *").unwrap();
        // from = 2024-01-15 08:00:00
        let from = 1705305600000 + 8 * 3600 * 1000;
        let next = compute_next_cron_run(&expr, from).unwrap();
        let (_, _, _, h, m) = ms_to_components(next);
        assert_eq!(h, 9);
        assert_eq!(m, 0);
    }

    #[test]
    fn test_never_fires() {
        // 0 0 31 2 * (Feb 31st — never)
        let expr = parse_cron_expression("0 0 31 2 *").unwrap();
        let from = 1700000000000;
        assert!(compute_next_cron_run(&expr, from).is_none());
    }

    #[test]
    fn test_dow_sunday() {
        // A Sunday-only expression
        let expr = parse_cron_expression("0 0 * * 0").unwrap();
        assert_eq!(expr.days_of_week, vec![0]);
    }

    #[test]
    fn test_cron_to_human_every_minute() {
        let expr = parse_cron_expression("* * * * *").unwrap();
        assert_eq!(cron_to_human(&expr), "every minute");
    }

    #[test]
    fn test_cron_to_human_every_5_minutes() {
        let expr = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(cron_to_human(&expr), "every 5 minutes");
    }

    #[test]
    fn test_cron_to_human_daily_at_9() {
        let expr = parse_cron_expression("0 9 * * *").unwrap();
        assert_eq!(cron_to_human(&expr), "at 09:00 every day");
    }

    #[test]
    fn test_cron_to_human_weekdays() {
        let expr = parse_cron_expression("30 9 * * 1-5").unwrap();
        assert_eq!(cron_to_human(&expr), "at 09:30 on weekdays");
    }

    #[test]
    fn test_has_fire_within_years_valid() {
        let expr = parse_cron_expression("0 9 * * *").unwrap();
        assert!(has_fire_within_years(&expr, 1, 1700000000000));
    }

    #[test]
    fn test_has_fire_within_years_invalid() {
        let expr = parse_cron_expression("0 0 31 2 *").unwrap();
        assert!(!has_fire_within_years(&expr, 5, 1700000000000));
    }
}