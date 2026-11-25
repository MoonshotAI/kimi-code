import { ErrorCodes, isError2 } from '#/errors';

export async function unlessProjectGone<T>(opened: Promise<T>): Promise<T | undefined> {
  try {
    return await opened;
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.WORKSPACE_NOT_FOUND) return undefined;
    throw error;
  }
}
