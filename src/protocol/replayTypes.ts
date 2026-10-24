export interface FileInfo {
  FileName: string
  FilePath?: string
  FileSizeText: string
  Sha256?: string
}

export interface MatchInfo {
  ReplayId: string
  GameVersion: string
  RoomId: number | string
  RoomServerId: number
  MapId: number
  MapName: string
  mapImage?: string
  MapType?: number
  Difficulty: number
  RoundCount: number
  TurnCount: number
  FrameCount: number
  CommandTypeCount?: number
  PlayerDeaths: number
  GameProgress?: number
  GameMaxProgress?: number
  ProgressText?: string
  StartTimeText?: string
  FinishTimeText?: string
  DurationText: string
  ResultText: string
  WinnerText: string
  BossName: string
  AwardsText: string
  WarningCount?: number
}

export interface RelicDisplay {
  Id: number
  Name: string
  Quality: string
  image?: string
}

export interface PlayerSummary {
  Id: number | string
  Nickname: string
  Slot: number
  AccountLevel: number
  HeroId: number
  HeroName: string
  avatar?: string
  FinalStatus: string
  Hp: number
  MaxHp: number
  HpText?: string
  Gold: number
  Attack: number
  Defense: number
  Damage: number
  Injured: number
  Kills: number
  Healing: number
  MovePoints: number
  UsedCards: number
  UsedSkills: number
  TransferGold?: number
  BoughtRelics: number
  FinalBossKill: boolean
  SelectedRelicCount?: number
  SelectedRelicsText?: string
  SelectedRelics?: RelicDisplay[]
}

export interface MonsterRecord {
  Id: string
  HeroId: number
  MonsterName: string
  image?: string
  MonsterIndex?: number
  SpawnFrameIndex: number
  SpawnRound: number
  SpawnNodeId: number
  SpawnLandType?: number
  SpawnLandName?: string
  SpawnedOnMonsterTile: boolean
  SpawnedByMonsterTile: boolean
  Hp: number
  MaxHp: number
  Attack: number
  Defense: number
  LastFrameIndex: number
  LastRound: number
  LastNodeId: number
  DeathFrameIndex?: number
  DeathRound?: number
  KillerId?: string
  KillerName?: string
  Status: string
  StatusKey: 'alive' | 'defeated' | 'left'
}

export interface MonsterTileStep {
  FrameIndex: number
  Round: number
  PlayerId: string
  PlayerName: string
  NodeId: number
  MonsterIds: string[]
  MonsterCount: number
}

export interface MonsterSummary {
  total: number
  defeated: number
  alive: number
  spawnTile: number
  tileSpawned: number
  tileDefeated: number
  steps: number
  tileSteps: number
}

export interface TimelineEvent {
  FrameIndex: number
  Round: number
  RoundText?: string
  PlayerId: number | string
  PlayerName: string
  Type: string
  Title: string
  Description: string
  icon?: string
}

export interface RelicRecord {
  FrameIndex: number
  Round: number
  PlayerId: number | string
  PlayerName: string
  HeroName: string
  Kind: string
  Level?: number
  LevelText?: string
  RelicId?: number
  RelicName: string
  Quality: string
  OptionsText?: string
  Options?: RelicDisplay[]
  Source: string
  RefreshNumber?: number
  IsRefresh?: boolean
  RefreshText?: string
  image?: string
  sourceIcon?: string
}

export interface ShopRecord {
  FrameIndex: number
  Round: number
  PlayerId: number | string
  PlayerName: string
  HeroName: string
  ShopType: string
  OptionsText: string
  Price?: number
  Discount?: number
  PriceText?: string
  FreeCard?: number
  FreeCardNum?: number
  Alreadys?: boolean[]
  BuyIndices?: number[]
  BoughtText?: string
  PurchaseText: string
  IsClosed?: boolean
  HasPurchase?: boolean
  SoldOutText?: string
}

export interface ProtocolFrame {
  Index: number
  Offset: number
  OffsetText?: string
  CmdId: number
  MessageName: string
  PayloadLength: number
  detail?: string
}

export interface StatItem {
  Name: string
  Count: number
  Percent: number
  BarWidth?: number
  Detail?: string
}

export interface ReplayStatistics {
  commands: StatItem[]
  actions: StatItem[]
  relicQualities: StatItem[]
}

export interface PerformancePoint {
  Round: number
  Damage: number
  Transfer: number
  DamageDelta: number
  TransferDelta: number
  Cards: number
  CardsDelta: number
  EarnedGold: number
  CurrentGold: number
  Deaths: number
  Kills: number
  EarnedGoldDelta: number
  CurrentGoldDelta: number
  DeathsDelta: number
  KillsDelta: number
}
export interface PlayerPerformance {
  PlayerId: string
  Points: PerformancePoint[]
  Dice: { Round: number; Values: number[]; MovePoint: number; Controlled: boolean }[]
}

export interface ReplayReport {
  performance?: PlayerPerformance[]
  file: FileInfo
  match: MatchInfo
  players: PlayerSummary[]
  events: TimelineEvent[]
  relics: RelicRecord[]
  shops: ShopRecord[]
  monsters: MonsterRecord[]
  monsterTileSteps: MonsterTileStep[]
  monsterSummary: MonsterSummary
  frames: ProtocolFrame[]
  statistics: ReplayStatistics
  warnings?: string[]
}
