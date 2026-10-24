import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReplayReport, ProtocolFrame, TimelineEvent, RelicRecord, ShopRecord, StatItem, PlayerSummary, MonsterRecord, MonsterTileStep } from './replayTypes.js'

interface Field { number: number; name: string; kind: string; repeated: boolean; target: string | null }
type Message = Record<string, unknown>
const schemaJson = JSON.parse(readFileSync(fileURLToPath(new URL('./replaySchema.json', import.meta.url)), 'utf8')) as Record<string, Field[]>
const catalogJson = JSON.parse(readFileSync(fileURLToPath(new URL('./assetCatalog.json', import.meta.url)), 'utf8')) as unknown
const schemas = schemaJson
const fieldTables = new Map<string, Map<number, Field>>()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const commands: Record<number, string> = {
  1002: 'PredictActionS2C', 1003: 'RunningGameS2C', 1016: 'GameFinishS2C',
  1040: 'UpdateHeroAttrS2C', 1096: 'HeroSkillMoveEffectS2C', 1098: 'SayPhraseNotifyS2C',
  1112: 'SyncRelicsS2C', 1113: 'ReplaySnapshotS2C', 1115: 'ReplayDieS2C',
  5022: 'ThrowDiceS2C',
  5030: 'ShopBuyS2C', 5212: 'SelectRelicS2C', 5214: 'MonsterPursuitS2C',
  5216: 'PVEShopBuyS2C', 5250: 'BuyRelicS2C', 5324: 'VendorBuyCardS2C',
}
const actionNames: Record<number, string> = {
  5021: '掷骰', 5027: '移动', 5029: '购买', 5033: '战斗', 5035: '回合流转',
  5037: '行动开始', 5039: '行动结束', 5041: '使用卡牌', 5047: '地块事件',
  5049: '战斗结算', 5053: '技能行动', 5055: '属性结算', 5059: '商店事件',
  5063: '随机事件', 5067: '特殊移动', 5069: '恢复事件', 5071: '星币事件',
  5073: '角色事件', 5075: '地图事件', 5077: '特殊事件', 5081: 'Buff 事件',
  5083: '效果事件', 5093: '任务事件', 5211: '筹码候选', 5213: '怪物追击',
  5215: 'PVE 商店', 5249: '到达筹码地块', 5259: '筹码事件',
  5309: 'PVE 事件', 5313: 'PVE 事件', 5317: '特殊事件', 5323: 'PVE 事件', 5377: '特殊事件',
}

/** Strict protobuf reader. Numeric wire types come from the game-generated schema;
 * all 64-bit integers stay decimal strings, including IDs and action sequence numbers. */
class Reader {
  readonly view: DataView
  position = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  need(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.position)
      throw new Error('protobuf 字段被截断或长度无效。')
  }
  varint(): bigint {
    let result = 0n
    for (let i = 0; i < 10; i++) {
      this.need(1)
      const byte = this.bytes[this.position++]
      if (i === 9 && byte > 1) throw new Error('protobuf varint 超过 64 位。')
      result |= BigInt(byte & 127) << BigInt(i * 7)
      if (!(byte & 128)) return result
    }
    throw new Error('protobuf varint 无终止字节。')
  }
  lengthBytes(): Uint8Array {
    const length = Number(this.varint()); this.need(length)
    const bytes = this.bytes.subarray(this.position, this.position + length)
    this.position += length
    return bytes
  }
  skip(wire: number, field: number, depth = 0) {
    if (depth > 64) throw new Error('protobuf group 嵌套超过 64 层。')
    switch (wire) {
      case 0: this.varint(); return
      case 1: this.need(8); this.position += 8; return
      case 2: this.lengthBytes(); return
      case 3:
        while (this.position < this.bytes.length) {
          const tag = Number(this.varint()), nestedWire = tag & 7, nestedField = tag >>> 3
          if (nestedWire === 4) { if (nestedField !== field) throw new Error('protobuf group 不匹配。'); return }
          if (nestedField === 0) throw new Error('protobuf 字段编号为 0。')
          this.skip(nestedWire, nestedField, depth + 1)
        }
        throw new Error('protobuf group 被截断。')
      case 5: this.need(4); this.position += 4; return
      default: throw new Error(`protobuf wire type ${wire} 无效。`)
    }
  }
  scalar(field: Field, depth: number): unknown {
    const start = this.position
    switch (field.kind) {
      case 'Message': return decodeProtocol(field.target!, this.lengthBytes(), depth + 1)
      case 'String': return textDecoder.decode(this.lengthBytes())
      case 'Bytes': return this.lengthBytes()
      case 'SFixed32': this.need(4); this.position += 4; return this.view.getInt32(start, true)
      case 'Fixed32': this.need(4); this.position += 4; return this.view.getUint32(start, true)
      case 'SFixed64': this.need(8); this.position += 8; return this.view.getBigInt64(start, true).toString()
      case 'Fixed64': this.need(8); this.position += 8; return this.view.getBigUint64(start, true).toString()
      case 'Float': this.need(4); this.position += 4; return this.view.getFloat32(start, true)
      case 'Double': this.need(8); this.position += 8; return this.view.getFloat64(start, true)
      case 'Bool': return this.varint() !== 0n
      case 'Enum': case 'Int32': return Number(BigInt.asIntN(32, this.varint()))
      case 'UInt32': return Number(BigInt.asUintN(32, this.varint()))
      case 'Int64': return BigInt.asIntN(64, this.varint()).toString()
      case 'UInt64': return this.varint().toString()
      case 'SInt32': { const value = this.varint(); return Number(BigInt.asIntN(32, (value >> 1n) ^ -(value & 1n))) }
      case 'SInt64': { const value = this.varint(); return ((value >> 1n) ^ -(value & 1n)).toString() }
      default: throw new Error(`不支持的 protobuf 字段类型 ${field.kind}。`)
    }
  }
}
function wireType(kind: string) {
  if (['Message', 'String', 'Bytes'].includes(kind)) return 2
  if (['SFixed64', 'Fixed64', 'Double'].includes(kind)) return 1
  if (['SFixed32', 'Fixed32', 'Float'].includes(kind)) return 5
  return 0
}
export function decodeProtocol(type: string, bytes: Uint8Array, depth = 0): Message {
  if (depth > 64) throw new Error('protobuf 嵌套超过 64 层。')
  let table = fieldTables.get(type)
  if (!table) {
    if (!schemas[type]) throw new Error(`没有协议定义 ${type}。`)
    table = new Map(schemas[type].map(field => [field.number, field])); fieldTables.set(type, table)
  }
  const reader = new Reader(bytes), result: Message = {}
  while (reader.position < bytes.length) {
    const rawTag = reader.varint()
    if (rawTag > 0xffffffffn) throw new Error('protobuf tag 超过 32 位。')
    const tag = Number(rawTag), number = tag >>> 3, wire = tag & 7
    if (number === 0) throw new Error('protobuf 字段编号为 0。')
    const field = table.get(number)
    if (!field) { reader.skip(wire, number); continue }
    const expectedWire = wireType(field.kind)
    // protobuf permits both packed and unpacked repeated numeric fields.
    if (field.repeated && wire === 2 && expectedWire !== 2) {
      const packed = new Reader(reader.lengthBytes())
      const values = (result[field.name] ??= []) as unknown[]
      while (packed.position < packed.bytes.length) values.push(packed.scalar(field, depth))
    } else if (wire === expectedWire) {
      const value = reader.scalar(field, depth)
      if (field.repeated) ((result[field.name] ??= []) as unknown[]).push(value)
      else if (field.kind === 'Message' && result[field.name]) result[field.name] = mergeMessages(result[field.name] as Message, value as Message)
      else result[field.name] = value
    } else reader.skip(wire, number) // Match the generated parser's unknown-field handling.
  }
  return result
}
function mergeMessages(first: Message, second: Message): Message {
  for (const [key, value] of Object.entries(second)) {
    const previous = first[key]
    if (Array.isArray(previous) && Array.isArray(value)) previous.push(...value)
    else if (previous && value && typeof previous === 'object' && typeof value === 'object' && !(value instanceof Uint8Array))
      first[key] = mergeMessages(previous as Message, value as Message)
    else first[key] = value
  }
  return first
}
const object = (value: unknown): Message => value && typeof value === 'object' ? value as Message : {}
const number = (value: unknown): number => typeof value === 'number' ? value : 0
const string = (value: unknown): string => value == null ? '' : String(value)
const id = (value: unknown): string => string(value) || '0'
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const messages = (value: unknown): Message[] => list(value).map(object)
const catalog = catalogJson as unknown as Record<string, Record<string, { id: number; name: string; quality?: string; image?: string }>>
function name(category: string, value: number, fallback: string) { return catalog[category]?.[String(value)]?.name || `${fallback} ${value}` }
const relicName = (value: number) => name('relics', value, '筹码')
const cardName = (value: number) => name('cards', value, '卡牌')
const quality = (value: number) => catalog.relics[String(value)]?.quality ?? '未知品质'
const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
function stats(counts: Map<string, number>, total: number): StatItem[] {
  const max = Math.max(1, ...counts.values())
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([Name, Count]) => ({ Name, Count, Percent: Count / Math.max(1, total), BarWidth: 130 * Count / max }))
}
function formatTime(value: unknown): string {
  const seconds = Number(value)
  if (!seconds || !Number.isFinite(seconds)) return '—'
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return string(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
function formatDuration(start: unknown, end: unknown): string {
  const seconds = Number(end) - Number(start)
  if (!(Number(start) > 0 && seconds >= 0)) return '—'
  return [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map(value => String(value).padStart(2, '0')).join(':')
}
function formatSize(bytes: number) {
  let value = bytes, unit = 0
  const units = ['B', 'KB', 'MB', 'GB']
  while (value >= 1024 && unit < 3) { value /= 1024; unit++ }
  return `${Number(value.toFixed(2))} ${units[unit]}`
}
interface Frame extends ProtocolFrame { payload: Uint8Array; decoded?: Message }
interface Offer { level: number; source: string; refresh: number }
interface Visit { frame: number; round: number; player: string; type: string; cards: number[]; alreadys: boolean[]; price: number; discount: number; freeCard: number; freeCardNum: number; buys: number[]; closed: boolean }

const MONSTER_TILE_LAND_TYPE = 19
function monsterStatus(key: MonsterRecord['StatusKey']) {
  if (key === 'defeated') return '被击败'
  if (key === 'left') return '离场（未记录击败）'
  return '存活至结算'
}

export interface DecodeOptions {
  /** 是否保留逐帧详情；API 默认关闭，避免把几 MB 的帧内容塞进响应。 */
  includeFrames?: boolean
}

/** Decode a server replay frame stream into a report; never inherit sample data. */
export function decodeReplay(buffer: ArrayBuffer | Uint8Array, fileName: string, options: DecodeOptions = {}): ReplayReport {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (!bytes.length) throw new Error('回放文件为空。')
  if (bytes.length > 512 * 1024 * 1024) throw new Error('回放文件超过 512 MB 安全限制。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), frames: Frame[] = []
  let offset = 0
  while (offset < bytes.length) {
    const frameOffset = offset
    if (bytes.length - offset < 6) throw new Error(`帧头被截断：offset=0x${offset.toString(16)}。`)
    const cmd = view.getInt16(offset, false), length = view.getInt32(offset + 2, false)
    offset += 6
    if (cmd <= 0) throw new Error(`无效命令号 ${cmd}。`)
    if (length < 0 || length > 64 * 1024 * 1024) throw new Error(`无效载荷长度 ${length}：帧 ${frames.length}。`)
    if (length > bytes.length - offset) throw new Error(`帧载荷被截断：帧 ${frames.length}。`)
    frames.push({ Index: frames.length, Offset: frameOffset, OffsetText: `0x${frameOffset.toString(16).toUpperCase()}`, CmdId: cmd,
      MessageName: commands[cmd] ?? `CMD ${cmd}`, PayloadLength: length, payload: bytes.subarray(offset, offset + length) })
    offset += length
  }
  const warnings: string[] = []
  const decode = (frame: Frame): Message => {
    if (frame.decoded) return frame.decoded
    try { return frame.decoded = commands[frame.CmdId] ? decodeProtocol(commands[frame.CmdId], frame.payload) : {} }
    catch (error) { throw new Error(`帧 ${frame.Index}（${frame.MessageName}）解码失败：${error instanceof Error ? error.message : error}`) }
  }
  const runningFrame = frames.find(frame => frame.CmdId === 1003)
  if (!runningFrame) throw new Error('找不到开局锚点 RunningGameS2C（cmd 1003）。')
  const initial = object(decode(runningFrame).Room)
  if (!Object.keys(initial).length || !initial.Players || !initial.MapId) throw new Error('开局 Room 数据无法解析，可能与当前游戏协议版本不兼容。')
  const snapshots = frames.filter(frame => frame.CmdId === 1113).map(frame => ({ frame, value: decode(frame) }))
  const finishFrame = frames.findLast(frame => frame.CmdId === 1016)
  const finish = finishFrame ? decode(finishFrame) : {}
  const final = snapshots.length ? object(snapshots.at(-1)!.value.Room) : initial
  if (!snapshots.length) warnings.push('未记录回合快照，玩家属性使用开局状态。')
  if (!finishFrame) warnings.push('未记录结算帧，此回放可能尚未结束或文件不完整。')
  const finalPlayers = new Map(messages(final.Players).map(player => [id(player.Id), player]))
  const players: PlayerSummary[] = messages(initial.Players).map(player => {
    const playerId = id(player.Id), initialHero = object(player.Hero)
    const finalPlayer = finalPlayers.get(playerId), hero = object(finalPlayer?.Hero), cond = object(hero.Cond)
    const heroId = number(initialHero.HeroId), hp = number(hero.Hp), maxHp = number(hero.MaxHp)
    return { Id: playerId, Nickname: string(player.Nick) || playerId, Slot: number(player.Slot), AccountLevel: number(player.Level),
      HeroId: heroId, HeroName: name('characters', heroId, '角色'),
      FinalStatus: !finalPlayer?.Hero ? (finalPlayer?.IsBot ? '机器人占位 · 无末局英雄数据' : '无末局英雄数据') : hp > 0 ? '存活至结算' : '结算时生命值为 0',
      Hp: hp, MaxHp: maxHp, HpText: `${hp} / ${maxHp}`, Gold: number(hero.Gold), Attack: number(hero.Attack), Defense: number(hero.Defense),
      Damage: number(cond.TotalDamage), Injured: number(cond.TotalInjured), Kills: number(cond.KillPveMonster), Healing: number(cond.TreatmentScore),
      MovePoints: number(cond.MovePoint), UsedCards: number(cond.UseCard), UsedSkills: number(cond.UseSkill), TransferGold: number(cond.TransferGold),
      BoughtRelics: number(hero.BuyRelicNum), FinalBossKill: Boolean(cond.FinalKillBoss), SelectedRelicCount: 0, SelectedRelicsText: '',
    }
  })
  const playerNames = new Map(players.map(player => [player.Id, player.Nickname]))
  const playerHeroes = new Map(players.map(player => [player.Id, player.HeroName]))
  const playerName = (value: string) => value === '0' ? '系统' : playerNames.get(value) ?? `实体 ${value}`
  const roundCount = Math.max(0, ...snapshots.map(snapshot => number(object(snapshot.value.Room).Round)))
  const awards = messages(finish.Awards).filter(award => number(award.Value) !== 0).map(award => `${name('items', number(award.Key), '物品')} ×${number(award.Value)}`)
  const boss = messages(final.Monsters).map(monster => object(monster.Hero)).find(hero => [2, 10].includes(number(hero.MonsterType)))
  const winner = id(finish.Winer)
  // Snapshots capture the state at a turn boundary. Attribute differences to
  // the round that just elapsed, using the last boundary of each round.
  const performance = players.map(player => {
    const baseline = messages(initial.Players).find(p => id(p.Id) === String(player.Id))
    const initialCond = object(object(baseline?.Hero).Cond)
    const rounds = new Map<number, { Damage: number; Transfer: number; Cards: number; EarnedGold: number; CurrentGold: number; Deaths: number; Kills: number }>()
    for (const snapshot of snapshots) {
      const room = object(snapshot.value.Room)
      const p = messages(room.Players).find(p => id(p.Id) === String(player.Id))
      if (!p?.Hero) continue
      const cond = object(object(p.Hero).Cond)
      const round = Math.max(0, number(room.Round) - (snapshot.frame.Index === snapshots.at(-1)?.frame.Index ? 0 : 1))
      if (!rounds.has(round) || snapshot.frame.Index === snapshots.at(-1)?.frame.Index)
        rounds.set(round, { Damage: number(cond.TotalDamage), Transfer: number(cond.TransferGold), Cards: number(cond.UseCard), EarnedGold: number(cond.Gold), CurrentGold: number(object(p.Hero).Gold), Deaths: number(cond.SelfDie), Kills: number(cond.KillPveMonster) })
    }
    let damage = number(initialCond.TotalDamage), transfer = number(initialCond.TransferGold), cards = number(initialCond.UseCard)
    let earnedGold = number(initialCond.Gold), currentGold = number(object(baseline?.Hero).Gold), deaths = number(initialCond.SelfDie), kills = number(initialCond.KillPveMonster)
    const Points = [...rounds].sort(([a], [b]) => a - b).map(([Round, totals]) => {
      const point = { Round, ...totals, DamageDelta: totals.Damage - damage, TransferDelta: totals.Transfer - transfer, CardsDelta: totals.Cards - cards, EarnedGoldDelta: totals.EarnedGold - earnedGold, CurrentGoldDelta: totals.CurrentGold - currentGold, DeathsDelta: totals.Deaths - deaths, KillsDelta: totals.Kills - kills }
      damage = totals.Damage; transfer = totals.Transfer; cards = totals.Cards
      earnedGold = totals.EarnedGold; currentGold = totals.CurrentGold; deaths = totals.Deaths; kills = totals.Kills
      return point
    })
    return { PlayerId: String(player.Id), Points, Dice: [] as { Round: number; Values: number[]; MovePoint: number; Controlled: boolean }[] }
  })
  const report: ReplayReport = {
    performance,
    file: { FileName: fileName, FileSizeText: formatSize(bytes.length) },
    match: { ReplayId: string(finish.ReplayId) || fileName, GameVersion: string(finish.Version) || '—', RoomId: id(initial.Id),
      RoomServerId: number(initial.RoomServerId), MapId: number(initial.MapId), MapName: name('maps', number(initial.MapId), '地图'),
      MapType: number(initial.MapType), Difficulty: number(initial.Difficulty), RoundCount: roundCount, TurnCount: Math.max(0, snapshots.length - 1),
      FrameCount: frames.length, PlayerDeaths: number(final.PlayerTotalDie), GameProgress: number(final.GameProgress), GameMaxProgress: number(final.GameMaxProgress),
      ProgressText: `${number(final.GameProgress)} / ${number(final.GameMaxProgress)}`, StartTimeText: formatTime(initial.StartTime), FinishTimeText: formatTime(finish.FinishTime),
      DurationText: formatDuration(initial.StartTime, finish.FinishTime), ResultText: finishFrame ? (BigInt(winner) > 0n ? '胜利' : '已结束') : '未记录结算',
      WinnerText: BigInt(winner) > 0n ? `获胜方 ${winner}` : '未记录获胜方', BossName: boss ? name('monsters', number(boss.HeroId), '怪物') : '—',
      AwardsText: awards.length ? awards.join(' · ') : '未记录奖励', WarningCount: 0 },
    players, events: [], relics: [], shops: [], frames: [],
    monsters: [], monsterTileSteps: [], monsterSummary: { total: 0, defeated: 0, alive: 0, spawnTile: 0, tileSpawned: 0, tileDefeated: 0, steps: 0 },
    statistics: { commands: [], actions: [], relicQualities: [] }, warnings,
  }
  const commandCounts = new Map<string, number>(), actionCounts = new Map<string, number>(), qualityCounts = new Map<string, number>()
  const seenActions = new Set<string>(), offers = new Map<string, Offer>(), costs = new Map<string, number>(), confirmed = new Set<string>()
  const visits = new Map<string, Visit>(), selected = new Map<string, number[]>()
  let currentRound = 0, currentPlayer = '0'
  const event = (frame: number, player: string, type: string, title: string, description: string, round = currentRound) => {
    const entry: TimelineEvent = { FrameIndex: frame, Round: round, RoundText: `第 ${round} 轮`, PlayerId: player, PlayerName: playerName(player), Type: type, Title: title, Description: description }
    report.events.push(entry)
  }
  const playerIds = new Set(players.map(player => String(player.Id)))
  const landTypes = new Map<number, number>()
  const lastPlayerNodes = new Map<string, number>()
  const monsterMap = new Map<string, MonsterRecord>()
  const initialRound = number(initial.Round) || 1
  const observeLands = (room: Message) => {
    for (const land of messages(room.Lands)) {
      const node = number(land.Key)
      landTypes.set(node, number(object(land.Value).LandType))
    }
  }
  const observePlayers = (room: Message, frame: number, round: number, countSteps: boolean) => {
    const steps: MonsterTileStep[] = []
    for (const player of messages(room.Players)) {
      const playerId = id(player.Id), node = number(object(player.Hero).NodeId)
      if (playerId === '0') continue
      const previous = lastPlayerNodes.get(playerId)
      if (countSteps && previous !== undefined && previous !== node && landTypes.get(node) === MONSTER_TILE_LAND_TYPE) {
        const step: MonsterTileStep = { FrameIndex: frame, Round: round, PlayerId: playerId, PlayerName: playerName(playerId), NodeId: node, MonsterIds: [], MonsterCount: 0 }
        steps.push(step)
        report.monsterTileSteps.push(step)
      }
      lastPlayerNodes.set(playerId, node)
    }
    return steps
  }
  const observeMonsters = (room: Message, frame: number, round: number) => {
    const spawned: MonsterRecord[] = []
    for (const monster of messages(room.Monsters)) {
      const monsterId = id(monster.Id)
      if (monsterId === '0') continue
      const hero = object(monster.Hero), heroId = number(hero.HeroId), node = number(hero.NodeId)
      let record = monsterMap.get(monsterId)
      if (!record) {
        record = {
          Id: monsterId, HeroId: heroId, MonsterName: name('monsters', heroId, '怪物'),
          SpawnFrameIndex: frame, SpawnRound: round, SpawnNodeId: node,
          SpawnLandType: landTypes.get(node), SpawnedOnMonsterTile: landTypes.get(node) === MONSTER_TILE_LAND_TYPE,
          SpawnedByMonsterTile: false,
          Hp: number(hero.Hp), MaxHp: number(hero.MaxHp), Attack: number(hero.Attack), Defense: number(hero.Defense),
          LastFrameIndex: frame, LastRound: round, LastNodeId: node,
          Status: '存活至结算', StatusKey: 'alive',
        }
        monsterMap.set(monsterId, record)
        spawned.push(record)
      }
      record.MonsterIndex = number(hero.MonsterIndex)
      record.Hp = number(hero.Hp)
      record.MaxHp = number(hero.MaxHp)
      record.Attack = number(hero.Attack)
      record.Defense = number(hero.Defense)
      record.LastFrameIndex = frame
      record.LastRound = round
      record.LastNodeId = node
    }
    return spawned
  }
  const attributeTileSpawns = (steps: MonsterTileStep[], spawned: MonsterRecord[], current: string) => {
    if (!steps.length || !spawned.length) return
    const target = steps.find(step => step.PlayerId === current) ?? steps[0]
    for (const monster of spawned) {
      target.MonsterIds.push(monster.Id)
      monster.SpawnedByMonsterTile = true
    }
    target.MonsterCount = target.MonsterIds.length
  }
  observeLands(initial)
  observePlayers(initial, 0, initialRound, false)
  observeMonsters(initial, 0, initialRound)
  const shopRecord = (visit: Visit): ShopRecord => {
    const bought = visit.buys.filter(index => index >= 0 && index < visit.cards.length).map(index => `第${index + 1}个 ${cardName(visit.cards[index])}`).join('、')
    return { FrameIndex: visit.frame, Round: visit.round, PlayerId: visit.player, PlayerName: playerName(visit.player), HeroName: playerHeroes.get(visit.player) ?? '未知角色',
      ShopType: visit.type, OptionsText: visit.cards.map(cardName).join('、'), Price: visit.price, Discount: visit.discount,
      PriceText: `${visit.price} 星币${visit.discount ? `（折后 ${Math.max(0, visit.price - visit.discount)}）` : ''}`,
      FreeCard: visit.freeCard, FreeCardNum: visit.freeCardNum, Alreadys: visit.alreadys, BuyIndices: visit.buys,
      BoughtText: bought, PurchaseText: bought || (visit.closed ? '未购买' : '未记录购买'), HasPurchase: !!bought, IsClosed: visit.closed,
      SoldOutText: visit.alreadys.map((sold, index) => sold ? `第${index + 1}格` : '').filter(Boolean).join('、') }
  }
  const actionData = (action: Message, type: string, frame: number): Message | undefined => {
    try { return decodeProtocol(type, action.Data instanceof Uint8Array ? action.Data : new Uint8Array()) }
    catch (error) { warnings.push(`帧 ${frame} 的动作 ${number(action.Id)} 载荷无法解码：${error instanceof Error ? error.message : error}`); return undefined }
  }
  for (const frame of frames) {
    increment(commandCounts, `${frame.CmdId} · ${frame.MessageName}`)
    if (frame.CmdId === 5022) {
      const roll = decode(frame)
      const owner = performance.find(p => p.PlayerId === id(roll.PlayerId))
      owner?.Dice.push({ Round: currentRound, Values: list(roll.Vals).map(number), MovePoint: number(roll.MovePoint), Controlled: Boolean(roll.IsControlMovePoint) })
    } else if (frame.CmdId === 1113) {
      const snapshot = decode(frame), room = object(snapshot.Room)
      currentRound = number(room.Round); currentPlayer = id(snapshot.PlayerId)
      observeLands(room)
      const steps = observePlayers(room, frame.Index, currentRound, true)
      const spawned = observeMonsters(room, frame.Index, currentRound)
      attributeTileSpawns(steps, spawned, currentPlayer)
      if (frame.Index !== snapshots.at(-1)?.frame.Index) event(frame.Index, currentPlayer, '回合', '行动回合开始', `${playerName(currentPlayer)} 的行动快照`)
    } else if (frame.CmdId === 1002) {
      for (const action of messages(decode(frame).Actions)) {
        const actionId = number(action.Id), sn = id(action.Sn), playerId = id(action.PlayerId)
        if (sn !== '0') { if (seenActions.has(sn)) continue; seenActions.add(sn) }
        const title = actionNames[actionId] ?? `动作 ${actionId}`
        increment(actionCounts, `${actionId} · ${title}`)
        if (actionId === 5249) {
          const data = actionData(action, 'BuyRelicC2S', frame.Index)
          if (data) costs.set(playerId, number(data.RelicGold))
        } else if (actionId === 5250) confirmed.add(playerId)
        else if (actionId === 5211) {
          const data = actionData(action, 'SelectRelicC2S', frame.Index); if (!data) continue
          const level = number(data.Lv), previous = offers.get(playerId)
          const purchaseCost = confirmed.delete(playerId) ? costs.get(playerId) ?? 0 : 0
          costs.delete(playerId)
          const source = previous?.level === level ? previous.source : purchaseCost > 0 ? '筹码地块购买' : number(data.SupLv) > 0 ? '升星' : '任务'
          const refresh = previous?.level === level ? previous.refresh + 1 : 0
          offers.set(playerId, { level, source, refresh })
          const optionRelics = list(data.Relics).map(number).map(Id => ({ Id, Name: relicName(Id), Quality: quality(Id) }))
          const options = optionRelics.map(relic => `${relic.Name}（${relic.Quality}）`).join('、')
          const record: RelicRecord = { FrameIndex: frame.Index, Round: currentRound, PlayerId: playerId, PlayerName: playerName(playerId), HeroName: playerHeroes.get(playerId) ?? '未知角色',
            Kind: refresh ? '刷新候选' : '首次候选', Level: level, LevelText: level > 0 ? `${level} 档` : '—', RelicId: 0, RelicName: '', Quality: '',
            OptionsText: options, Options: optionRelics, Source: source, RefreshNumber: refresh, IsRefresh: refresh > 0, RefreshText: refresh ? `第 ${refresh} 次刷新` : '首次候选' }
          report.relics.push(record)
          event(frame.Index, playerId, '筹码', refresh ? `第 ${refresh} 次刷新筹码` : `${source} · 出现三个候选筹码`, `${playerName(playerId)}${refresh ? '刷新后看到了' : '可以从中选择'}：${options}${purchaseCost > 0 ? `（价格 ${purchaseCost} 星币）` : ''}`)
        } else if (actionId === 5029 || actionId === 5215) {
          const data = actionData(action, actionId === 5029 ? 'ShopBuyC2S' : 'PVEShopBuyC2S', frame.Index); if (!data) continue
          const cards = list(data.Cards).map(number), alreadys = list(data.Alreadys).map(Boolean), previous = visits.get(playerId)
          if (previous && previous.cards.length === cards.length && previous.cards.every((value, index) => value === cards[index])) {
            if (alreadys.length) previous.alreadys = alreadys
            continue
          }
          if (previous) report.shops.push(shopRecord(previous))
          const type = actionId === 5029 ? 'PVP商店' : 'PVE商店', price = number(data.Gold), discount = number(data.DisCountGold)
          visits.set(playerId, { frame: frame.Index, round: currentRound, player: playerId, type, cards, alreadys, price, discount,
            freeCard: number(data.FreeCard), freeCardNum: number(data.FreeCardNum), buys: [], closed: false })
          event(frame.Index, playerId, '商店', `进入${type}`, `${playerName(playerId)}走进商店，货架上有：${cards.map(cardName).join('、')}${price > 0 ? `（每张 ${price} 星币${discount > 0 ? `，折后 ${Math.max(0, price - discount)}` : ''}）` : ''}`)
        } else if (actionId === 5323) {
          const data = actionData(action, 'VendorBuyCardC2S', frame.Index); if (!data) continue
          const card = number(data.CardId), bought = Boolean(data.IsBuy)
          report.shops.push(shopRecord({ frame: frame.Index, round: currentRound, player: playerId, type: '商人买卡', cards: card > 0 ? [card] : [], alreadys: [],
            price: number(data.Gold), discount: 0, freeCard: 0, freeCardNum: 0, buys: bought && card > 0 ? [0] : [], closed: true }))
          event(frame.Index, playerId, '商店', bought ? '商人买卡' : '商人未买卡', `${playerName(playerId)}在商人处${bought ? `买下了「${cardName(card)}」` : '没有买卡'}`)
        } else event(frame.Index, playerId, '行动', title, playerId === '0' ? title : `${playerName(playerId)}进行了${title}`)
      }
    } else if (frame.CmdId === 5212) {
      const data = decode(frame), playerId = id(data.PlayerId), relicId = number(data.RelicId), offer = offers.get(playerId), refresh = offer?.refresh ?? 0
      if (data.IsReroll) { event(frame.Index, playerId, '筹码', '请求刷新筹码', `${playerName(playerId)}请求更换这一组三个候选筹码`); continue }
      offers.delete(playerId)
      const relic = relicId > 0 ? relicName(relicId) : '—', relicQuality = relicId > 0 ? quality(relicId) : '—'
      report.relics.push({ FrameIndex: frame.Index, Round: currentRound, PlayerId: playerId, PlayerName: playerName(playerId), HeroName: playerHeroes.get(playerId) ?? '未知角色',
        Kind: '选择', RelicId: relicId, RelicName: relic, Quality: relicQuality, Level: offer?.level ?? 0, LevelText: offer?.level ? `${offer.level} 档` : '—',
        OptionsText: '', Source: offer?.source ?? '来源未记录', RefreshNumber: refresh, IsRefresh: false, RefreshText: `此前刷新 ${refresh} 次` })
      event(frame.Index, playerId, '筹码', `获得筹码 · ${relic}`, `${playerName(playerId)}通过${offer?.source ?? '未知途径'}获得了${relic}，此前刷新 ${refresh} 次`)
      if (relicId > 0) { const ids = selected.get(playerId) ?? []; ids.push(relicId); selected.set(playerId, ids); increment(qualityCounts, relicQuality) }
    } else if (frame.CmdId === 5250) {
      const data = decode(frame), playerId = id(data.PlayerId)
      if (number(data.Select) > 0) confirmed.add(playerId)
      else if (data.Exit) { costs.delete(playerId); event(frame.Index, playerId, '筹码', '离开筹码地块', `${playerName(playerId)}没有购买筹码`) }
    } else if (frame.CmdId === 1115) {
      const data = decode(frame), killer = id(data.KillerId), hero = number(data.HeroId), dyingId = id(data.PlayerId)
      if (!playerIds.has(dyingId)) {
        let record = monsterMap.get(dyingId)
        if (!record) {
          record = {
            Id: dyingId, HeroId: hero, MonsterName: name('monsters', hero, '怪物'),
            SpawnFrameIndex: -1, SpawnRound: 0, SpawnNodeId: 0, SpawnedOnMonsterTile: false, SpawnedByMonsterTile: false,
            Hp: 0, MaxHp: 0, Attack: 0, Defense: 0,
            LastFrameIndex: frame.Index, LastRound: currentRound, LastNodeId: 0,
            Status: '被击败（未捕获出生）', StatusKey: 'defeated',
          }
          monsterMap.set(dyingId, record)
        }
        record.DeathFrameIndex = frame.Index
        record.DeathRound = currentRound
        record.KillerId = killer
        record.KillerName = playerName(killer)
        record.StatusKey = 'defeated'
        record.Status = record.SpawnFrameIndex < 0 ? '被击败（未捕获出生）' : monsterStatus('defeated')
      }
      event(frame.Index, killer, '击败', `击败 ${name('monsters', hero, '怪物')}`, `目标 ID ${hero} · 击杀者 ${playerName(killer)}`)
    } else if (frame.CmdId === 5030 || frame.CmdId === 5216) {
      const data = decode(frame), playerId = id(data.PlayerId), buys = list(data.BuyCards).map(number)
      const closed = frame.CmdId === 5216 ? Boolean(data.IsClose) : !buys.length, visit = visits.get(playerId)
      if (visit) { for (const buy of buys) if (buy >= 0 && !visit.buys.includes(buy)) visit.buys.push(buy); if (closed) visit.closed = true }
      else if (buys.length) event(frame.Index, playerId, '商店', frame.CmdId === 5216 ? 'PVE 商店购买' : 'PVP 商店购买', `购买了 ${buys.length} 张卡牌（缺少候选上下文）`)
    } else if (frame.CmdId === 5324) {
      const data = decode(frame), playerId = id(data.PlayerId), bought = Boolean(data.IsBuy), visit = visits.get(playerId)
      if (visit) { visit.closed = true; if (bought && !visit.buys.length && visit.cards.length) visit.buys.push(0) }
      event(frame.Index, playerId, '商店', bought ? '商人买卡' : '商人未买卡', `${playerName(playerId)}${bought ? '从商人处购买了一张卡牌' : '没有从商人处买卡'}`)
    } else if (frame.CmdId === 5214) event(frame.Index, currentPlayer, '系统', '怪物追击结算', frame.MessageName)
  }
  if (finishFrame) event(finishFrame.Index, '0', '结算', `对局结束 · ${report.match.ResultText}`, `${report.match.WinnerText} · ${report.match.AwardsText}`, roundCount)
  const finalSnapshotFrame = snapshots.at(-1)?.frame.Index ?? -1
  for (const record of monsterMap.values()) {
    if (record.DeathFrameIndex !== undefined) {
      record.StatusKey = 'defeated'
      record.Status = record.SpawnFrameIndex < 0 ? '被击败（未捕获出生）' : monsterStatus('defeated')
    } else if (finalSnapshotFrame >= 0 && record.LastFrameIndex === finalSnapshotFrame) {
      record.StatusKey = 'alive'
      record.Status = monsterStatus('alive')
    } else {
      record.StatusKey = 'left'
      record.Status = monsterStatus('left')
    }
  }
  report.monsters = [...monsterMap.values()].sort((a, b) => {
    const left = a.SpawnFrameIndex < 0 ? (a.DeathFrameIndex ?? Number.MAX_SAFE_INTEGER) : a.SpawnFrameIndex
    const right = b.SpawnFrameIndex < 0 ? (b.DeathFrameIndex ?? Number.MAX_SAFE_INTEGER) : b.SpawnFrameIndex
    return left - right || a.Id.localeCompare(b.Id)
  })
  report.monsterSummary = {
    total: report.monsters.length,
    defeated: report.monsters.filter(monster => monster.StatusKey === 'defeated').length,
    alive: report.monsters.filter(monster => monster.StatusKey === 'alive').length,
    spawnTile: report.monsters.filter(monster => monster.SpawnedOnMonsterTile).length,
    tileSpawned: report.monsters.filter(monster => monster.SpawnedByMonsterTile).length,
    tileDefeated: report.monsters.filter(monster => monster.SpawnedByMonsterTile && monster.StatusKey === 'defeated').length,
    steps: report.monsterTileSteps.length,
  }
  for (const player of players) { const ids = selected.get(String(player.Id)) ?? []; player.SelectedRelicCount = ids.length; player.SelectedRelicsText = ids.map(relicName).join('、'); player.SelectedRelics = ids.map(Id => ({ Id, Name: relicName(Id), Quality: quality(Id) })) }
  for (const visit of visits.values()) report.shops.push(shopRecord(visit))
  report.match.CommandTypeCount = commandCounts.size
  report.match.WarningCount = warnings.length
  report.statistics = { commands: stats(commandCounts, frames.length), actions: stats(actionCounts, [...actionCounts.values()].reduce((sum, count) => sum + count, 0)),
    relicQualities: stats(qualityCounts, [...qualityCounts.values()].reduce((sum, count) => sum + count, 0)) }
  // Frame details are opt-in: the default API response only needs analysis, not every payload.
  report.frames = options.includeFrames
    ? frames.map(({ payload, decoded, ...frame }) => ({ ...frame,
        detail: decoded ? JSON.stringify(decoded, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value, 2)
          : `${payload.length ? '原始十六进制：\n' : '（空载荷）'}${Array.from(payload.subarray(0, 4096), byte => byte.toString(16).padStart(2, '0')).join(' ')}${payload.length > 4096 ? `\n已省略 ${payload.length - 4096} 字节。` : ''}` }))
    : []
  return report
}


