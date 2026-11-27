import { uiPreferences } from '@moonshot-ai/app-core/lib';
import { uiPreferencesServerKey } from './api/config';

uiPreferences.bind(uiPreferencesServerKey());
