import type { AppIdentity } from "../../features/auth/appIdentity";

/** Share initialization and serialize explicit resets within this runtime. */
export function createAppIdentityStore(
  load: () => Promise<AppIdentity>,
  remove: () => Promise<void>,
) {
  let pending: Promise<AppIdentity> | undefined;

  function remember(operation: Promise<AppIdentity>): Promise<AppIdentity> {
    const result = operation.catch((error: unknown) => {
      if (pending === result) {
        pending = undefined;
      }
      throw error;
    });
    pending = result;
    return result;
  }

  return {
    getOrCreateAppIdentity(): Promise<AppIdentity> {
      return pending ?? remember(load());
    },
    resetAppIdentity(): Promise<AppIdentity> {
      const previous = pending;
      return remember(
        (async () => {
          await previous?.catch(() => undefined);
          await remove();
          return load();
        })(),
      );
    },
  };
}
