/**
 * Keeps the chat controller alive across route changes.
 *
 * The dashboard unmounts a plugin page when you navigate to another tab, and
 * this page's cleanup used to `dispose()` the controller — which closed the
 * socket and dropped every open session. Coming back meant re-opening each tab
 * by hand.
 *
 * So the controller is a module-level singleton instead of a per-mount object.
 * A route change removes only the React subscription (which
 * `useSyncExternalStore` does on unmount); the socket, the tab list and any
 * in-flight turn carry on. Remounting picks the same instance back up, so the
 * tabs are exactly where they were — including a reply that kept streaming while
 * you were on another page.
 *
 * A module-scope singleton is deliberate and narrow: there is one chat page per
 * document, and the alternative (persisting the tab list to storage and resuming
 * each session on return) would drop in-flight turns and cost a round trip per
 * tab. Refcounting is tracked so tests can assert the lifetime rules.
 *
 * No DOM, no SDK import — the caller supplies the controller's options.
 */

export interface ControllerLike {
  dispose: () => void;
}

export interface ControllerHolder<T extends ControllerLike> {
  /** The live controller, created on first use. */
  acquire: () => T;
  /**
   * Drop one reference. The controller is NOT disposed: that is the whole point.
   * Returns the remaining reference count so callers (and tests) can see that
   * repeated mount/unmount cycles keep one instance.
   */
  release: () => number;
  /** The instance without creating one, for tests and diagnostics. */
  peek: () => T | null;
  /** Drop the instance entirely (tests, or a genuine teardown). */
  reset: () => void;
  refCount: () => number;
}

export function createControllerHolder<T extends ControllerLike>(factory: () => T): ControllerHolder<T> {
  let instance: T | null = null;
  let refs = 0;

  return {
    acquire() {
      if (!instance) instance = factory();
      refs += 1;
      return instance;
    },
    release() {
      refs = Math.max(0, refs - 1);
      return refs;
    },
    peek() {
      return instance;
    },
    reset() {
      const current = instance;
      instance = null;
      refs = 0;
      // Only a deliberate teardown actually closes the socket.
      current?.dispose();
    },
    refCount() {
      return refs;
    },
  };
}
