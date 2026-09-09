/** 受信 Main 的独占分析目录：普通工具工厂也不执行，避免初始化外部工具副作用。 */
export function selectPiToolCatalog<T>(exclusive: boolean | undefined, supplied: () => T[], normal: () => T[]): T[] {
  return exclusive ? supplied() : normal()
}
