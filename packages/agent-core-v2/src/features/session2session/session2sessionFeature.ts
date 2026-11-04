import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import {
  ISessionCreateTool,
  ISessionListTool,
  ISessionMessageService,
  ISessionReadTool,
  ISessionSendTool,
  SESSION2SESSION_FLAG_ID,
} from './session2session';
import { SessionMessageService } from './sessionMessageService';
import { SessionCreateTool } from './tools/sessionCreateTool';
import { SessionListTool } from './tools/sessionListTool';
import { SessionReadTool } from './tools/sessionReadTool';
import { SessionSendTool } from './tools/sessionSendTool';

export class Session2SessionFeature extends Feature {
  static override readonly name = 'session2session';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(SESSION2SESSION_FLAG_ID)) return;
    this.contributeAgentService(ISessionMessageService, SessionMessageService);
    this.contributeTool(ISessionSendTool, SessionSendTool, {
      name: 'session_send',
      activateWhenMissingFromProfile: true,
      domain: 'session2session',
    });
    this.contributeTool(ISessionReadTool, SessionReadTool, {
      name: 'session_read',
      activateWhenMissingFromProfile: true,
      domain: 'session2session',
    });
    this.contributeTool(ISessionCreateTool, SessionCreateTool, {
      name: 'session_create',
      activateWhenMissingFromProfile: true,
      domain: 'session2session',
    });
    this.contributeTool(ISessionListTool, SessionListTool, {
      name: 'session_list',
      activateWhenMissingFromProfile: true,
      domain: 'session2session',
    });
  }
}

registerFeature(Session2SessionFeature);
