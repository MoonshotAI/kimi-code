/** TUI-only daemon staging lifetimes for pasted media. */

export const IMAGE_STAGING_TTL_SECONDS = 60 * 60;
export const IMAGE_FILE_REF_MIN_REMAINING_MS = 60_000;
/** How long submit waits for a just-pasted image's background ingestion before falling back to the inline form. */
export const IMAGE_INGESTION_SUBMIT_WAIT_MS = 2_000;
