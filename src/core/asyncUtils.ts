export async function waitAllSettledWithTimeout<T>(promises: Promise<T>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
    });
    const result = await Promise.race([Promise.allSettled(promises), timeout]);
    return result !== 'timeout';
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
