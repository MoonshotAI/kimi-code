import en_common from './en/common';
import en_app from './en/app';
import en_sidebar from './en/sidebar';
import en_workspace from './en/workspace';
import en_conversation from './en/conversation';
import en_status from './en/status';
import en_composer from './en/composer';
import en_login from './en/login';
import en_providers from './en/providers';
import en_model from './en/model';
import en_sessions from './en/sessions';
import en_approval from './en/approval';
import en_question from './en/question';
import en_tasks from './en/tasks';
import en_thinking from './en/thinking';
import en_diff from './en/diff';
import en_fileTree from './en/fileTree';
import en_filePreview from './en/filePreview';
import en_mention from './en/mention';
import en_warnings from './en/warnings';
import en_commands from './en/commands';
import en_tools from './en/tools';
import en_layout from './en/layout';
import en_mobile from './en/mobile';
import en_theme from './en/theme';

import zh_common from './zh/common';
import zh_app from './zh/app';
import zh_sidebar from './zh/sidebar';
import zh_workspace from './zh/workspace';
import zh_conversation from './zh/conversation';
import zh_status from './zh/status';
import zh_composer from './zh/composer';
import zh_login from './zh/login';
import zh_providers from './zh/providers';
import zh_model from './zh/model';
import zh_sessions from './zh/sessions';
import zh_approval from './zh/approval';
import zh_question from './zh/question';
import zh_tasks from './zh/tasks';
import zh_thinking from './zh/thinking';
import zh_diff from './zh/diff';
import zh_fileTree from './zh/fileTree';
import zh_filePreview from './zh/filePreview';
import zh_mention from './zh/mention';
import zh_warnings from './zh/warnings';
import zh_commands from './zh/commands';
import zh_tools from './zh/tools';
import zh_layout from './zh/layout';
import zh_mobile from './zh/mobile';
import zh_theme from './zh/theme';
import en_onboarding from './en/onboarding';
import zh_onboarding from './zh/onboarding';
import en_settings from './en/settings';
import zh_settings from './zh/settings';
import en_header from './en/header';
import zh_header from './zh/header';
import en_sideChat from './en/sideChat';
import zh_sideChat from './zh/sideChat';

export const messages = {
  en: {
    common: en_common,
    app: en_app,
    sidebar: en_sidebar,
    workspace: en_workspace,
    conversation: en_conversation,
    status: en_status,
    composer: en_composer,
    login: en_login,
    providers: en_providers,
    model: en_model,
    sessions: en_sessions,
    approval: en_approval,
    question: en_question,
    tasks: en_tasks,
    thinking: en_thinking,
    diff: en_diff,
    fileTree: en_fileTree,
    filePreview: en_filePreview,
    mention: en_mention,
    warnings: en_warnings,
    commands: en_commands,
    tools: en_tools,
    layout: en_layout,
    mobile: en_mobile,
    theme: en_theme,
    onboarding: en_onboarding,
    settings: en_settings,
    header: en_header,
    sideChat: en_sideChat,
  },
  zh: {
    common: zh_common,
    app: zh_app,
    sidebar: zh_sidebar,
    workspace: zh_workspace,
    conversation: zh_conversation,
    status: zh_status,
    composer: zh_composer,
    login: zh_login,
    providers: zh_providers,
    model: zh_model,
    sessions: zh_sessions,
    approval: zh_approval,
    question: zh_question,
    tasks: zh_tasks,
    thinking: zh_thinking,
    diff: zh_diff,
    fileTree: zh_fileTree,
    filePreview: zh_filePreview,
    mention: zh_mention,
    warnings: zh_warnings,
    commands: zh_commands,
    tools: zh_tools,
    layout: zh_layout,
    mobile: zh_mobile,
    theme: zh_theme,
    onboarding: zh_onboarding,
    settings: zh_settings,
    header: zh_header,
    sideChat: zh_sideChat,
  },
} as const;

export default messages;
