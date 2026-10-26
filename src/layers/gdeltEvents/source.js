const API_URL = '/api/gdelt-events';

/** Request and validate one GDELT events snapshot from the local proxy. */
export function createGdeltEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal, includeFree = true } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `${API_URL}?free=${includeFree ? '1' : '0'}`,
        { signal },
      );
      if (!response.ok) throw new Error(`GDELT events HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!payload || !Array.isArray(payload.events))
        throw new Error('Malformed GDELT events response');
      return payload;
    },
  };
}
