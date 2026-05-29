import type { AgentRecord } from '../../types';
import type { PillTone } from '../shared/Pill';

type RecordType = AgentRecord['type'];

/** Visual tone for each record type. */
export const TYPE_TONE: Record<RecordType, PillTone> = {
  'metadata':                              'meta',
  'config.update':                         'config',
  'turn.prompt':                           'turn',
  'turn.steer':                            'turn',
  'turn.cancel':                           'warning',
  'context.append_message':                'assistant',
  'context.append_loop_event':             'meta',
  'context.clear':                         'warning',
  'context.apply_compaction':              'compaction',
  'tools.register_user_tool':              'tools',
  'tools.unregister_user_tool':            'tools',
  'tools.set_active_tools':                'tools',
  'tools.update_store':                    'meta',
  'permission.set_mode':                   'approval',
  'permission.record_approval_result':     'approval',
  'usage.record':                          'meta',
  'full_compaction.begin':                 'compaction',
  'full_compaction.cancel':                'warning',
  'full_compaction.complete':              'success',
  'plan_mode.enter':                       'lifecycle',
  'plan_mode.cancel':                      'warning',
  'plan_mode.exit':                        'success',
  'background.stop':                       'warning',
};

/** Compact human label for each record type (used in the type badge). */
export const TYPE_LABEL: Record<RecordType, string> = {
  'metadata': 'meta',
  'config.update': 'config',
  'turn.prompt': 'prompt',
  'turn.steer': 'steer',
  'turn.cancel': 'cancel',
  'context.append_message': 'message',
  'context.append_loop_event': 'loop',
  'context.clear': 'clear',
  'context.apply_compaction': 'compacted',
  'tools.register_user_tool': 'tool+',
  'tools.unregister_user_tool': 'tool-',
  'tools.set_active_tools': 'tools',
  'tools.update_store': 'store',
  'permission.set_mode': 'perm',
  'permission.record_approval_result': 'approval',
  'usage.record': 'usage',
  'full_compaction.begin': 'compact↻',
  'full_compaction.cancel': 'compact×',
  'full_compaction.complete': 'compact✓',
  'plan_mode.enter': 'plan↻',
  'plan_mode.cancel': 'plan×',
  'plan_mode.exit': 'plan✓',
  'background.stop': 'bg-stop',
};
