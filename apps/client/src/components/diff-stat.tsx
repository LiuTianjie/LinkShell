import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";

/** "+12 −3", leaving out a side that is zero: a new file is "+16", not "+16 −0" in red. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {added ? <Text style={{ color: colors.diffAddText }}>+{added}</Text> : null}
      {added && removed ? " " : null}
      {removed ? <Text style={{ color: colors.diffDelText }}>−{removed}</Text> : null}
    </>
  );
}
