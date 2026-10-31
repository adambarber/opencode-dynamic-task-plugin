/**
 * A delivery-claim store whose FIRST read hands back a caller-chosen result —
 * a parked promise, a rejection, or a value. The one place a durable delivery
 * claim can be made to stop or fail on cue, shared by the two suites that need
 * it (notify-gate-delivery's claim-walk-throws case and the continuation
 * crash-window case) so the store's shape lives once.
 *
 * `takeDeliveryClaim` reads the claim, writes the mark, settles, pauses, then
 * re-reads. Parking the FIRST read holds the walk inside the crash window
 * BEFORE any dial has queued the real debt; rejecting it makes the walk throw
 * before any delivering arm runs. Either way the first read is the seam.
 */
export function claimStoreFirstRead(onFirstRead) {
  let reads = 0;
  return {
    drop: () => {},
    read: async () => {
      reads += 1;
      return reads === 1 ? onFirstRead() : null;
    },
    settled: async () => {},
    write: () => {},
  };
}
