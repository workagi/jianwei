export type ClaimStage = "announced" | "available" | "restricted" | "corrected" | "unknown";
export function claimStage(title: string): ClaimStage {
  if (/更正|勘误|纠正|correction|corrected/i.test(title)) return "corrected";
  if (/暂停|撤回|取消|停止|尚未|否认|辟谣|不(?:再|向|会|支持|开放)|无法|not available|withdraw|suspend|den(?:y|ies|ied)/i.test(title)) return "restricted";
  if (/即将|计划|预告|将(?:于|向|在|开放|推出)|coming soon|plans to/i.test(title)) return "announced";
  if (/发布|开放|上线|开源|可用|launch|released?|available|open.?source/i.test(title)) return "available";
  return "unknown";
}
export const STAGE_LABELS: Record<ClaimStage, string> = {
  announced: "材料提到预告或计划", available: "材料提到发布或开放",
  restricted: "材料提到限制或撤回，请核对", corrected: "材料提到更正，请核对", unknown: "首次收录",
};
