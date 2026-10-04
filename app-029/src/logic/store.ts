/**
 * 本地存储（无后端）：项目、预设、字库偏好。
 * 只落 localStorage，不发起任何网络请求。
 */

import materialsData from '../data/materials.json'
import type { Preset } from './materials'
import { defaultProject, normalizeTunings } from './layout'
import type { Align, Project } from './types'

const KEY_PROJECTS = 'app029.projects.v1'
const KEY_PRESET = 'app029.preset.v1'
const KEY_PREFS = 'app029.prefs.v1'

const ALIGN_VALUES: Align[] = ['left', 'center', 'right', 'justify']

/**
 * 旧项目读取迁移：结构缺字段时就地补默认，保证「缺字段也能打开」。
 * 缺的逐行设置（lineTunings 整个没有 / 单条缺字段）一律按跟随全局处理。
 * 面板/排版/LED 等基础字段缺失时，从当前默认项目补同名值（即「按现有的全局值接着用」）。
 */
export function migrateProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const d = defaultProject('__migration__')
  if (typeof o.id !== 'string' || !o.id) return null
  const p = JSON.parse(JSON.stringify(d)) as Project
  p.id = o.id
  p.name = typeof o.name === 'string' ? o.name : p.name
  p.panelMaterialId = typeof o.panelMaterialId === 'string' ? o.panelMaterialId : p.panelMaterialId
  p.sheetId = typeof o.sheetId === 'string' ? o.sheetId : p.sheetId
  p.ledModuleId = typeof o.ledModuleId === 'string' ? o.ledModuleId : p.ledModuleId
  p.createdAt = typeof o.createdAt === 'number' ? o.createdAt : Date.now()
  p.updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : p.createdAt

  const layout = (o.layout ?? {}) as Record<string, unknown>
  const panel = (layout.panel ?? {}) as Record<string, unknown>
  const settings = (layout.settings ?? {}) as Record<string, unknown>
  const led = (o.led ?? {}) as Record<string, unknown>

  const num = (v: unknown, dft: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dft)
  p.layout.panel = {
    wMm: num(panel.wMm, p.layout.panel.wMm),
    hMm: num(panel.hMm, p.layout.panel.hMm),
    frameMm: num(panel.frameMm, p.layout.panel.frameMm),
    mounting: panel.mounting === 'wall' || panel.mounting === 'board' || panel.mounting === 'freestanding' ? panel.mounting : p.layout.panel.mounting
  }
  p.layout.settings = {
    align: ALIGN_VALUES.includes(settings.align as Align) ? (settings.align as Align) : p.layout.settings.align,
    baseSizeMm: num(settings.baseSizeMm, p.layout.settings.baseSizeMm),
    fontId: typeof settings.fontId === 'string' ? settings.fontId : p.layout.settings.fontId,
    weight: num(settings.weight, p.layout.settings.weight),
    strokeLimitMm: num(settings.strokeLimitMm, p.layout.settings.strokeLimitMm),
    trackRatio: num(settings.trackRatio, p.layout.settings.trackRatio),
    marginRatio: num(settings.marginRatio, p.layout.settings.marginRatio),
    lineGapRatio: num(settings.lineGapRatio, p.layout.settings.lineGapRatio)
  }
  p.led = {
    moduleSpacingMm: num(led.moduleSpacingMm, p.led.moduleSpacingMm),
    modulePowerW: num(led.modulePowerW, p.led.modulePowerW),
    moduleLumen: num(led.moduleLumen, p.led.moduleLumen),
    safetyFactor: num(led.safetyFactor, p.led.safetyFactor),
    psuEfficiency: num(led.psuEfficiency, p.led.psuEfficiency)
  }
  // 逐字项做最小清洗（老版本字段缺失时补默认，缺 line 的归到第 0 行）
  p.layout.items = Array.isArray(layout.items)
    ? layout.items
        .filter((it) => it && typeof it === 'object' && typeof (it as Record<string, unknown>).char === 'string')
        .map((it, idx) => {
          const x = it as Record<string, unknown>
          return {
            char: x.char as string,
            trackMm: num(x.trackMm, Math.round(p.layout.settings.trackRatio * 300)),
            offsetYMm: num(x.offsetYMm, 0),
            mode: x.mode === 'outline' ? 'outline' : 'solid',
            line: Number.isInteger(x.line) ? Math.max(0, x.line as number) : 0,
            trackTouched: !!x.trackTouched,
            seq: Number.isInteger(x.seq) ? (x.seq as number) : idx
          }
        })
    : []
  // 旧项目没有逐行设置 → 空数组（全部跟随全局）；有但缺字段/类型错 → 逐条清洗，丢的按跟随
  p.layout.lineTunings = normalizeTunings(layout.lineTunings)
  return p
}

export interface Prefs {
  defaultFontId: string
  defaultWeight: number
  nightPreview: boolean
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储空间不足等异常：忽略写入失败，不影响当前会话使用
  }
}

/** 读取并迁移全部项目；无法识别的坏数据跳过（不影响其它项目打开） */
export function listProjects(): Project[] {
  const rawList = readJson<unknown[]>(KEY_PROJECTS, [])
  const list: Project[] = []
  if (Array.isArray(rawList)) {
    for (const raw of rawList) {
      const p = migrateProject(raw)
      if (p) list.push(p)
    }
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null
}

export function saveProject(p: Project): void {
  const list = listProjects()
  const idx = list.findIndex((x) => x.id === p.id)
  const next = { ...p, updatedAt: Date.now() }
  if (idx >= 0) list[idx] = next
  else list.unshift(next)
  writeJson(KEY_PROJECTS, list)
}

export function deleteProject(id: string): void {
  writeJson(
    KEY_PROJECTS,
    listProjects().filter((p) => p.id !== id)
  )
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = newId()
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  saveProject(copy)
  return copy
}

export function newId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createProject(name: string, panel?: { wMm?: number; hMm?: number; frameMm?: number }): Project {
  const p = defaultProject(newId(), panel)
  p.name = name
  const prefs = loadPrefs()
  p.layout.settings.fontId = prefs.defaultFontId
  p.layout.settings.weight = prefs.defaultWeight
  saveProject(p)
  return p
}

function mergePreset(base: Preset, patch: Partial<Preset>): Preset {
  const out: Preset = JSON.parse(JSON.stringify(base))
  if (patch.process) out.process = { ...out.process, ...patch.process }
  if (patch.acrylicSheets) out.acrylicSheets = patch.acrylicSheets
  if (patch.ledModules) out.ledModules = patch.ledModules
  if (patch.psu) out.psu = { ...out.psu, ...patch.psu }
  if (patch.consumables) out.consumables = patch.consumables
  if (patch.labor) out.labor = patch.labor
  if (patch.panelMaterials) out.panelMaterials = patch.panelMaterials
  return out
}

export function defaultPresetDeep(): Preset {
  return JSON.parse(JSON.stringify(materialsData)) as Preset
}

export function loadPreset(): Preset {
  const saved = readJson<Partial<Preset> | null>(KEY_PRESET, null)
  if (!saved) return defaultPresetDeep()
  return mergePreset(defaultPresetDeep(), saved)
}

export function savePreset(preset: Preset): void {
  writeJson(KEY_PRESET, preset)
}

export function resetPreset(): Preset {
  const fresh = defaultPresetDeep()
  writeJson(KEY_PRESET, fresh)
  return fresh
}

export function loadPrefs(): Prefs {
  return readJson<Prefs>(KEY_PREFS, { defaultFontId: 'hei', defaultWeight: 400, nightPreview: false })
}

export function savePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...p }
  writeJson(KEY_PREFS, next)
  return next
}