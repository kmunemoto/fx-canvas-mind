// Lightweight client-side persistence for subscription cancellation state.
// Stripe is the source of truth; this is just for UI display until a webhook syncs profiles.

const KEY = "fx-cancellation-v1";

export interface CancellationInfo {
  userId: string;
  canceledAt: string; // ISO timestamp
  cancelDate: string | null; // YYYY-MM-DD (period end)
  cancelDateFormatted: string | null;
}

export const saveCancellation = (info: CancellationInfo) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(info));
  } catch {}
};

export const loadCancellation = (userId: string | undefined | null): CancellationInfo | null => {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CancellationInfo;
    if (parsed.userId !== userId) return null;
    // Auto-clear if past the cancel date
    if (parsed.cancelDate) {
      const today = new Date().toISOString().split("T")[0];
      if (today > parsed.cancelDate) {
        localStorage.removeItem(KEY);
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearCancellation = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {}
};
