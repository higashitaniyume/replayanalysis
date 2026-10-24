# replayanalysis JSON API

服务只返回 JSON，不提供网页。回放直接从官方 CDN 下载，按区服选择端点。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/query` | 按回放 ID 查询并解析，返回 JSON |
| GET | `/` | 与 `/query` 相同 |
| GET | `/healthz` | 服务状态、worker 队列、缓存与上游并发信息 |

## 查询参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `id` | 是 | — | 回放 ID，1–32 位数字 |
| `server` | 否 | `cnprod` | `cnprod` / `cndev` / `jpprod` / `jpdev`；也接受 `0`–`3`、`cn`、`jp`、`global`、`intl`、`default` |
| `includeFrames` | 否 | `false` | `1` / `true` / `yes` 时返回逐帧详情；默认省略以减小响应 |

## 示例

```bash
curl "https://apra.hiynet.com/query?id=1792225809771422&server=cnprod"
curl "https://apra.hiynet.com/?id=1792225809771422&server=jpprod"
curl "https://apra.hiynet.com/query?id=1792225809771422&includeFrames=1"
```

```powershell
$r = Invoke-RestMethod 'https://apra.hiynet.com/query?id=1792225809771422'
$r.monsterSummary | Format-List
$r.monsterTileSteps | Format-Table
```

## 响应结构

顶层字段：

| 字段 | 说明 |
|---|---|
| `file` | 回放文件名、大小，可能包含 SHA-256 |
| `match` | 地图、房间、版本、回合、帧数、结算、Boss 等对局摘要 |
| `players` | 玩家最终属性与统计 |
| `performance` | 按回合的表现曲线与掷骰记录 |
| `events` | 事件时间线 |
| `relics` | 筹码候选、刷新与选择记录 |
| `shops` | 商店进店、候选与购买记录 |
| `monsters` | 本局观测到的全部怪物 |
| `monsterTileSteps` | 踩中刷怪地块并实际触发刷新的踩点 |
| `monsterSummary` | 怪物与刷怪地块汇总 |
| `frames` | 协议帧元数据；默认空数组，`includeFrames=1` 时才包含详情 |
| `statistics` | 命令、行动、筹码品质统计 |
| `warnings` | 解析警告 |

### 刷怪地块字段

- `monsterTileSteps` 只包含“踩中刷怪地块，并且同一快照内确实出现了新怪物”的记录；经过但没有停下、踩中但没有刷出怪物都不会记录。
- `monsterTileSteps[].MonsterIds` 是这次踩点刷出的怪物实体 ID。
- `monsters[].SpawnedByMonsterTile` 为 `true` 表示该怪物可归因到某次踩点。
- `monsterSummary.steps` / `tileSteps` 是触发刷新的踩点次数；`tileSpawned` / `tileDefeated` 是这些踩点刷出的怪物数与已击败数。
- `spawnTile` 表示“首次出现在刷怪地块上”的怪物数，不等同于踩中触发，筛选时不要使用该字段。

### 示例片段

```json
{
  "monsterSummary": {
    "total": 22,
    "defeated": 21,
    "alive": 1,
    "spawnTile": 9,
    "tileSpawned": 2,
    "tileDefeated": 2,
    "steps": 2,
    "tileSteps": 2
  },
  "monsterTileSteps": [
    {
      "FrameIndex": 1234,
      "Round": 3,
      "PlayerId": "1184313",
      "PlayerName": "古明地小五",
      "NodeId": 42,
      "MonsterIds": ["92241"],
      "MonsterCount": 1
    }
  ]
}
```

## 响应头

| 头 | 说明 |
|---|---|
| `X-Request-Id` | 请求 ID，同时写入访问日志 |
| `X-Replay-Id` | 回放 ID |
| `X-Replay-Server` | 规范化后的区服 |
| `X-Cache` | `HIT` / `MISS` / `COALESCED` |

## 错误

错误响应：

```json
{ "error": "invalid_id", "message": "id 必须是 1-32 位数字" }
```

| 状态 | `error` 示例 | 说明 |
|---|---|---|
| 400 | `missing_id` / `invalid_id` / `invalid_server` | 参数错误 |
| 404 | `replay_not_found` | CDN 上不存在该回放，或区服不对 |
| 413 | `replay_too_large` | 超过回放大小限制 |
| 422 | `decode_failed` | 下载内容不是可解析的回放 |
| 502 | `upstream_error` | CDN 请求失败 |
| 503 | `decode_busy` / `upstream_busy` | 解析或下载队列已满 |
| 504 | `upstream_timeout` | CDN 响应超时 |

## 健康检查

```bash
curl "https://apra.hiynet.com/healthz"
```

返回 worker、队列、上游并发与缓存统计。配置项见仓库 `src/config.ts`。
