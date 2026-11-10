import { findFirstResolvableKimi } from './reach.mjs';
import {
  classifyShim,
  deleteShim,
  detectLegacyShims,
  renameInPlace,
} from './migrate.mjs';

export async function planTakeover(ownRoot, detectionPath, reachabilityPath, platform) {
  const detections = await detectLegacyShims(ownRoot, detectionPath, platform);
  if (detections.length === 0) return { kind: /** @type {const} */ ('noop') };

  const classifications = await Promise.all(
    detections.map(async (detection) => {
      const c = await classifyShim(detection.shimPath, platform);
      return { ...c, detection };
    }),
  );

  const actionable = classifications.filter((c) => c.kind !== 'blocked');
  const blocked = classifications.filter((c) => c.kind === 'blocked');
  const blocker = await findFirstResolvableKimi(
    ownRoot,
    reachabilityPath,
    actionable.map((c) => c.shimPath),
    classifications.map((c) => c.shimPath),
    platform,
  );

  if (blocker.kind === 'own') {
    return { kind: /** @type {const} */ ('proceed'), detections, classifications, actionable, blocked };
  }
  if (blocker.kind === 'blocked-legacy') {
    return { kind: /** @type {const} */ ('blocked'), blocked, actionable };
  }
  if (blocker.kind === 'foreign') {
    return { kind: /** @type {const} */ ('foreign'), path: blocker.path };
  }
  return { kind: /** @type {const} */ ('not-on-path'), detection: detections[0] };
}

export async function executeTakeover(classifications) {
  const renames = [];
  const consolidates = [];
  const skippedForeignTarget = [];
  const deletes = [];
  const errors = [];
  let preserved = false;

  for (const c of classifications) {
    if (c.kind === 'blocked') continue;

    if (!preserved) {
      if (c.kind === 'renameable') {
        const r = await renameInPlace(c.shimPath, c.target);
        if (r.success) {
          renames.push(c);
          preserved = true;
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
      if (c.kind === 'consolidate') {
        const r = await deleteShim(c.shimPath);
        if (r.success) {
          consolidates.push(c);
          preserved = true;
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
      if (c.kind === 'delete-only') {
        const r = await deleteShim(c.shimPath);
        if (r.success) {
          skippedForeignTarget.push(c);
        } else {
          errors.push({ ...c, ...r });
        }
        continue;
      }
    } else {
      const r = await deleteShim(c.shimPath);
      if (r.success) {
        deletes.push(c);
      } else {
        errors.push({ ...c, ...r });
      }
    }
  }

  return { renames, consolidates, skippedForeignTarget, deletes, errors, preserved };
}

export async function verifyTakeover(ownRoot, reachabilityPath, allDetectedShimPaths, platform) {
  return findFirstResolvableKimi(ownRoot, reachabilityPath, [], allDetectedShimPaths, platform);
}
