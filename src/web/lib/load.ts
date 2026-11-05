/**
 * A part of the page fetched when first needed (the conversation, Settings, the usage page, the
 * tabs of Changes and files). On a flaky link one request can drop: it is made once more, a moment
 * later, before the part says it did not load.
 */
export function retried<T>(load: () => Promise<T>): Promise<T> {
  return load().catch(() => new Promise((resolve) => setTimeout(resolve, 800)).then(load));
}
