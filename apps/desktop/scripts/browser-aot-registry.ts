import { browserValidatorSchema } from '../src/shared/browser-validator';
import { browserValidators as browser } from '../src/shared/browser';
import { browserValidators as bounds } from '../src/shared/browser-bounds';
import { browserValidators as annotation } from '../src/shared/browser-annotation';
import { browserValidators as annotationDetails } from '../src/shared/browser-annotation-details';
import { browserValidators as automationUi } from '../src/shared/browser-automation-ui';
import { browserValidators as autoplay } from '../src/shared/browser-autoplay';
import { browserValidators as control } from '../src/shared/browser-control';
import { browserValidators as data } from '../src/shared/browser-data';
import { browserValidators as dataRecords } from '../src/shared/browser-data-records';
import { browserValidators as device } from '../src/shared/browser-device';
import { browserValidators as dialogs } from '../src/shared/browser-dialogs';
import { browserValidators as overlay } from '../src/shared/browser-overlay';
import { browserValidators as overlayModel } from '../src/shared/browser-overlay-model';
import { browserValidators as panelState } from '../src/shared/browser-panel-state';
import { browserValidators as receipt } from '../src/shared/browser-receipt';
import { browserValidators as run } from '../src/shared/browser-run';
import { browserValidators as search } from '../src/shared/browser-search';
import { browserValidators as sites } from '../src/shared/browser-sites';
import { browserValidators as sound } from '../src/shared/browser-sound';
import { browserValidators as userAgent } from '../src/shared/browser-user-agent';
import { browserValidators as zoom } from '../src/shared/browser-zoom';

const modules = {
  browser, 'browser-bounds': bounds, 'browser-annotation': annotation, 'browser-annotation-details': annotationDetails, 'browser-autoplay': autoplay,
  'browser-automation-ui': automationUi, 'browser-control': control, 'browser-data': data, 'browser-data-records': dataRecords,
  'browser-device': device, 'browser-dialogs': dialogs, 'browser-overlay': overlay, 'browser-overlay-model': overlayModel, 'browser-panel-state': panelState, 'browser-receipt': receipt, 'browser-run': run, 'browser-search': search,
  'browser-sites': sites, 'browser-sound': sound, 'browser-user-agent': userAgent, 'browser-zoom': zoom,
};

export const schemas = Object.fromEntries(Object.entries(modules).map(([name, validators]) => [name,
  Object.fromEntries(Object.entries(validators).map(([key, validator]) => [key, browserValidatorSchema(validator)])),
]));
