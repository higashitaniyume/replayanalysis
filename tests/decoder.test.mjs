import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeReplay } from '../dist/protocol/decoder.js'

function varint(value) {
  let n = BigInt(value)
  const bytes = []
  do {
    let byte = Number(n & 0x7fn)
    n >>= 7n
    if (n) byte |= 0x80
    bytes.push(byte)
  } while (n)
  return Buffer.from(bytes)
}

const tag = (field, wire) => varint((field << 3) | wire)
const sfixed32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(value)
  return buffer
}
const sfixed64 = (value) => {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(BigInt(value))
  return buffer
}
const scalar32 = (field, value) => Buffer.concat([tag(field, 5), sfixed32(value)])
const scalar64 = (field, value) => Buffer.concat([tag(field, 1), sfixed64(value)])
const bytesField = (field, value) => Buffer.concat([tag(field, 2), varint(value.length), value])
const stringField = (field, value) => bytesField(field, Buffer.from(value, 'utf8'))
const messageField = (field, value) => bytesField(field, value)

function baseLand(node, landType) {
  return Buffer.concat([scalar32(1, node), scalar32(2, landType)])
}

function hero({ playerId, heroId, nodeId = 0, hp = 20, maxHp = 20, attack = 5, defense = 3, monsterIndex = 0 }) {
  return Buffer.concat([
    scalar64(1, playerId),
    scalar32(2, heroId),
    scalar32(3, nodeId),
    scalar32(14, hp),
    scalar32(15, defense),
    scalar32(16, attack),
    scalar32(23, maxHp),
    scalar32(53, monsterIndex),
  ])
}

function player({ id, nick, slot = 0, heroId = 101, nodeId = 1, hp = 20, maxHp = 20 }) {
  return Buffer.concat([
    scalar64(1, id),
    stringField(2, nick),
    scalar32(6, slot),
    messageField(10, hero({ playerId: id, heroId, nodeId, hp, maxHp })),
  ])
}

function monster({ id, heroId = 1043, nodeId = 5, hp = 10, maxHp = 10 }) {
  return Buffer.concat([
    scalar64(1, id),
    messageField(10, hero({ playerId: id, heroId, nodeId, hp, maxHp, attack: 2, defense: 1, monsterIndex: 1 })),
  ])
}

function room({ round, playerNode, monsters = [] }) {
  const lands = [
    messageField(12, Buffer.concat([scalar32(1, 0), messageField(2, baseLand(0, 19))])),
    messageField(12, Buffer.concat([scalar32(1, 1), messageField(2, baseLand(1, 1))])),
  ]
  return Buffer.concat([
    scalar64(1, 9000000000000001n),
    scalar32(5, 82015),
    messageField(9, player({ id: 11, nick: '测试一号', nodeId: playerNode })),
    messageField(9, player({ id: 22, nick: '测试二号', nodeId: 1 })),
    ...monsters.map((item) => messageField(10, item)),
    ...lands,
    scalar32(14, round),
    scalar32(36, 4),
    scalar32(48, 3),
    scalar32(1001, 42),
  ])
}

function snapshot(playerId, value) {
  return Buffer.concat([scalar64(1, playerId), messageField(2, value)])
}

function die(playerId, heroId, killerId) {
  return Buffer.concat([scalar64(1, playerId), scalar32(2, heroId), scalar64(3, killerId)])
}

function frameStream(frames) {
  const chunks = []
  for (const [cmd, payload] of frames) {
    const header = Buffer.alloc(6)
    header.writeInt16BE(cmd, 0)
    header.writeInt32BE(payload.length, 2)
    chunks.push(header, payload)
  }
  return Buffer.concat(chunks)
}

test('decoder attributes a same-snapshot monster spawn to the spawn-tile step', () => {
  const replay = frameStream([
    [1003, messageField(1, room({ round: 1, playerNode: 1 }))],
    [1113, snapshot(11, room({ round: 1, playerNode: 0, monsters: [monster({ id: 5001 })] }))],
    [1113, snapshot(11, room({ round: 2, playerNode: 0 }))],
    [1115, die(5001, 1043, 22)],
  ])

  const report = decodeReplay(replay, 'synthetic', { includeFrames: false })
  assert.equal(report.match.MapId, 82015)
  assert.equal(report.match.FrameCount, 4)
  assert.equal(report.frames.length, 0)

  assert.equal(report.monsterTileSteps.length, 1)
  const step = report.monsterTileSteps[0]
  assert.equal(step.Round, 1)
  assert.equal(step.NodeId, 0)
  assert.deepEqual(step.MonsterIds, ['5001'])
  assert.equal(step.MonsterCount, 1)

  assert.equal(report.monsterSummary.steps, 1)
  assert.equal(report.monsterSummary.tileSpawned, 1)
  assert.equal(report.monsterSummary.tileDefeated, 1)
  assert.equal(report.monsterSummary.tileSteps, 1)
  const spawned = report.monsters.find((item) => item.Id === '5001')
  assert.ok(spawned)
  assert.equal(spawned.SpawnedByMonsterTile, true)
  assert.equal(spawned.SpawnFrameIndex, 1)
  assert.equal(spawned.StatusKey, 'defeated')
  assert.equal(spawned.KillerName, '测试二号')
})

test('landing without a monster refresh is not recorded', () => {
  const replay = frameStream([
    [1003, messageField(1, room({ round: 1, playerNode: 1 }))],
    [1113, snapshot(11, room({ round: 1, playerNode: 0 }))],
    [1113, snapshot(11, room({ round: 2, playerNode: 0 }))],
    [1113, snapshot(11, room({ round: 3, playerNode: 0 }))],
  ])
  const report = decodeReplay(replay, 'synthetic')
  assert.equal(report.monsterTileSteps.length, 0)
  assert.equal(report.monsterSummary.steps, 0)
  assert.equal(report.monsterSummary.tileSpawned, 0)
})

test('includeFrames keeps per-frame metadata for callers that ask for it', () => {
  const replay = frameStream([[1003, messageField(1, room({ round: 1, playerNode: 1 }))]])
  const report = decodeReplay(replay, 'synthetic', { includeFrames: true })
  assert.equal(report.frames.length, 1)
  assert.equal(report.frames[0].CmdId, 1003)
  assert.equal(typeof report.frames[0].detail, 'string')
})
