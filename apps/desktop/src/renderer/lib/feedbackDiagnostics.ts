import type { FeedbackDiagnosticsArchive } from '../../shared/feedback-diagnostics';

interface FeedbackDiagnosticsBridge {
  collectFeedbackDiagnostics?: () => Promise<FeedbackDiagnosticsArchive>;
}

function bridge(): FeedbackDiagnosticsBridge | undefined {
  return (window as { kimiDesktop?: FeedbackDiagnosticsBridge }).kimiDesktop;
}

export function canCollectFeedbackDiagnostics(): boolean {
  return bridge()?.collectFeedbackDiagnostics !== undefined;
}

export async function collectFeedbackDiagnostics(): Promise<File> {
  const desktop = bridge();
  if (desktop?.collectFeedbackDiagnostics === undefined) throw new Error('Feedback diagnostics are unavailable');
  const { fileName, bytes } = await desktop.collectFeedbackDiagnostics();
  return new File([bytes], fileName, { type: 'application/zip' });
}
