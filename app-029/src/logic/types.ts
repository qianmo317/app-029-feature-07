/**
 * 全局共享类型定义（对应规格书第 7 节数据模型）
 * 说明：内部长度单位统一 mm（1 位小数），金额统一整数「分」。
 */

export type Mounting = 'wall' | 'board' | 'freestanding'
export type Align = 'left' | 'center' | 'right' | 'justify'
export type CharMode = 'solid' | 'outline'

/** 门头面板参数；frameMm = 铝塑板边框宽度，有效安装区 = 面板尺寸 - 2×边框 */
export interface SignPanel {
  wMm: number
  hMm: number
  mounting: Mounting
  frameMm: number
}

/** 逐字项；line 为行号、seq 为全文字序（多行扩展，供逐字微调定位用） */
export interface CharItem {
  char: string
  trackMm: number
  offsetYMm: number
  mode: CharMode
  line: number
  /** 是否手动调整过字距（未调整时跟随「默认字距比例 × 字号」） */
  trackTouched?: boolean
  seq?: number
}

export interface LayoutSettings {
  align: Align
  baseSizeMm: number
  fontId: string
  weight: number
  strokeLimitMm: number
  /** 默认字距 = trackRatio × 字号 */
  trackRatio: number
  /** 自动字号时预留的左右留边比例 */
  marginRatio: number
  /** 默认行距（行与行之间墨迹间隙）= lineGapRatio × 字号 */
  lineGapRatio: number
}

/**
 * 逐行排版设置：身份是「这一行的文字内容」（lineText + 同内容第几次出现），
 * 不是行序号——插行/删行/改文字重认行时按内容对回，后面的行不串位。
 * 三个字段各自独立：null = 没单独设过，跟随 LayoutSettings 里的全局值，
 * 改全局值时只有跟随的行会动；非 null 即「单独设过」，界面要一眼能看出来。
 */
export interface LineTuning {
  /** 该行文字（重认行后由排版引擎按新内容改写） */
  text: string
  /** 逐行对齐；null = 跟随全局 align */
  align: Align | null
  /**
   * 本行墨迹底边到下一行墨迹顶边的间隙 mm；null = 跟随全局 lineGapRatio × 字号。
   * 记在「上一行」名下；最后一行的该值不参与排版。
   */
  gapBelowMm: number | null
  /** 本行整体上下偏移 mm（正值向下）；null/0 跟随全局即不偏移 */
  offsetYMm: number | null
}

export interface LayoutDef {
  panel: SignPanel
  items: CharItem[]
  settings: LayoutSettings
  /** 逐行设置（旧项目可能没有该字段，读取时按空数组合规化：全部跟随全局） */
  lineTunings?: LineTuning[]
}

export interface LedCfg {
  moduleSpacingMm: number
  modulePowerW: number
  moduleLumen: number
  safetyFactor: number
  psuEfficiency: number
}

export interface LedResult {
  /** 总布点长度（各连通域外轮廓周长之和） */
  perimeterTotalMm: number
  modules: number
  ratedW: number
  recommendedW: number
  suggestedPsu: string
  note: string
  /** 因向上取整补足的模组数 */
  extraModules: number
  /** 理论布点小数（L / spacing） */
  exactModules: number
  /** 末段余长 mm */
  spareMm: number
  psuCount: number
  psuUnitW: number
}

export type MaterialKind = 'acrylic' | 'led_module' | 'psu' | 'glue' | 'labor'

export interface Material {
  kind: MaterialKind
  spec: string
  qty: number
  unit: string
  unitPriceCents: number
  amountCents: number
}

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ContourInfo {
  areaMm2: number
  perimeterMm: number
  isHole: boolean
  blockIndex: number
}

export interface GlyphInfo {
  char: string
  fontId: string
  weight: number
  sizeMm: number
  bboxMm: BBox
  contours: ContourInfo[]
  /** 连通域（笔画块）数量 */
  strokeBlocks: number
  /** 最细笔画宽度 mm */
  minStrokeMm: number
  /** 最细笔画位置（mm，字形本地坐标 y 向下） */
  minStrokePoint: { x: number; y: number } | null
  /** 字体中不存在该字符 */
  missing: boolean
  /** 工艺警告 */
  warnings: string[]
}

export interface Project {
  id: string
  name: string
  layout: LayoutDef
  led: LedCfg
  /** 面板材料预设 id（见 materials.json 的 panelMaterials） */
  panelMaterialId: string
  sheetId: string
  ledModuleId: string
  createdAt: number
  updatedAt: number
}