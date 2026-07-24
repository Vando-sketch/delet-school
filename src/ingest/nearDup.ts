export type NearDupVerdict = {
  tier: 'duplicate' | 'flagged' | 'unique';
  distance: number | null;
  matchedFile: string | null;
};

export async function checkNearDuplicate(_markdown: string): Promise<NearDupVerdict> {
  return { tier: 'unique', distance: null, matchedFile: null };
}
