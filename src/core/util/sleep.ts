export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Whether `promise` settles within `ms`. The timer is cleared when it does,
 *  so a quick answer never keeps a CLI process alive for the full wait. */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolveWithin) => {
    const timer = setTimeout(() => resolveWithin(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolveWithin(true);
    };
    promise.then(done, done);
  });
}
