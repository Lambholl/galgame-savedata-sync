import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PosterSearchClient,
  PosterSearchError,
  createDefaultPosterKeyword,
  isPosterImageUrl,
  isPosterRequestAllowed,
} from '../src/index.ts'

/**
 * 按顺序返回预设响应的执行器，记录收到的请求；预设项是 Error 时 reject。
 *
 * @param {Array<Error | { status?: number, body: unknown }>} responses 依次消费。
 * @returns {{ execute: Function, requests: object[] }}
 */
function createExecutor(responses) {
  const requests = []
  const execute = async (request) => {
    requests.push(request)
    const next = responses.shift()
    if (next instanceof Error) {
      throw next
    }
    assert.ok(next, `没有为 ${request.url} 准备响应`)
    return {
      status: next.status ?? 200,
      contentType: 'application/json',
      body: typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
    }
  }
  return { execute, requests }
}

/**
 * 不真正等待的时钟，记录每次等待的毫秒数。
 *
 * @returns {{ time: number, waits: number[], now: Function, wait: Function }}
 */
function createClock() {
  const clock = {
    time: 0,
    waits: [],
    now: () => clock.time,
    wait: async (ms) => {
      clock.waits.push(ms)
      clock.time += ms
    },
  }
  return clock
}

/**
 * 用预设响应创建搜索客户端。
 *
 * @param {Array<Error | { status?: number, body: unknown }>} responses 依次消费。
 * @returns {{ client: PosterSearchClient, requests: object[], clock: object }}
 */
function createClient(responses) {
  const executor = createExecutor(responses)
  const clock = createClock()
  return {
    client: new PosterSearchClient(executor.execute, clock),
    requests: executor.requests,
    clock,
  }
}

test('VNDB 搜索优先取中文标题，预览用缩略图、保存用原图', async () => {
  const { client, requests } = createClient([
    {
      body: {
        more: false,
        results: [
          {
            id: 'v1',
            title: 'Sample Romaji',
            alttitle: 'サンプル',
            titles: [
              { lang: 'ja', title: 'サンプル' },
              { lang: 'zh-Hans', title: '样例' },
            ],
            released: '2020-01-02',
            image: {
              url: 'https://t.vndb.org/cv/1/1.jpg',
              thumbnail: 'https://t.vndb.org/cv.t/1/1.jpg',
            },
            developers: [{ name: 'Dev A', original: '开发 A' }, { name: 'Dev B' }],
          },
          { id: 'v2', title: 'No Image', image: null },
          { id: 'v3', title: 'Other Host', image: { url: 'https://example.com/a.jpg' } },
        ],
      },
    },
  ])
  const results = await client.search('vndb', '  样例  ')
  assert.deepEqual(results, [
    {
      kind: 'image',
      source: 'vndb',
      id: 'v1',
      title: '样例',
      subtitle: 'Sample Romaji',
      detail: '2020-01-02 · 开发 A / Dev B',
      previewUrl: 'https://t.vndb.org/cv.t/1/1.jpg',
      downloadUrl: 'https://t.vndb.org/cv/1/1.jpg',
    },
  ])
  const body = JSON.parse(requests[0].body)
  assert.deepEqual(body.filters, ['search', '=', '样例'])
  assert.equal(body.sort, 'searchrank')
  assert.equal(requests.every(isPosterRequestAllowed), true)
})

test('Bangumi 搜索只保留有原图的游戏条目', async () => {
  const { client } = createClient([
    {
      body: {
        total: 3,
        data: [
          {
            id: 10,
            type: 4,
            name: 'Original',
            name_cn: '',
            date: '2018-06-29',
            images: {
              large: 'https://lain.bgm.tv/pic/a.jpg',
              common: 'https://lain.bgm.tv/r/400/pic/a.jpg',
            },
          },
          { id: 11, type: 2, name: 'Anime', images: { large: 'https://lain.bgm.tv/pic/b.jpg' } },
          { id: 12, type: 4, name: 'No Cover', images: { large: '' } },
        ],
      },
    },
  ])
  assert.deepEqual(await client.search('bangumi', 'Original'), [
    {
      kind: 'image',
      source: 'bangumi',
      id: '10',
      title: 'Original',
      subtitle: null,
      detail: '2018-06-29',
      previewUrl: 'https://lain.bgm.tv/r/400/pic/a.jpg',
      downloadUrl: 'https://lain.bgm.tv/pic/a.jpg',
    },
  ])
})

test('Steam 搜索按商店素材拼出竖版封面地址，没有竖版封面的应用丢弃', async () => {
  const { client, requests } = createClient([
    {
      body: {
        total: 2,
        items: [
          { id: 100, name: 'Game' },
          { id: 200, name: 'Artbook' },
        ],
      },
    },
    {
      body: {
        response: {
          store_items: [
            {
              appid: 200,
              assets: { asset_url_format: 'steam/apps/200/${FILENAME}?t=1', header: 'h.jpg' },
            },
            {
              appid: 100,
              assets: {
                asset_url_format: 'steam/apps/100/${FILENAME}?t=2',
                library_capsule: 'abc/library_600x900.jpg',
                library_capsule_2x: 'abc/library_600x900_2x.jpg',
              },
            },
          ],
        },
      },
    },
  ])
  assert.deepEqual(await client.search('steam', 'Game'), [
    {
      kind: 'image',
      source: 'steam',
      id: '100',
      title: 'Game',
      subtitle: null,
      detail: null,
      previewUrl:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/100/abc/library_600x900.jpg?t=2',
      downloadUrl:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/100/abc/library_600x900_2x.jpg?t=2',
    },
  ])
  const input = new URL(requests[1].url).searchParams.get('input_json')
  assert.deepEqual(JSON.parse(input).ids, [{ appid: 100 }, { appid: 200 }])
})

test('Steam 搜不到应用时不再读取商店素材', async () => {
  const { client, requests } = createClient([{ body: { total: 0, items: [] } }])
  assert.deepEqual(await client.search('steam', 'Nothing'), [])
  assert.equal(requests.length, 1)
})

test('NextMoe 先列作品，再列作品的封面并把置顶封面排在前面', async () => {
  const { client, requests } = createClient([
    {
      body: {
        items: [
          {
            id: '15',
            display_name: '作品',
            latin: null,
            release_date: '2016-07-29',
            cover: { url: 'https://image.kungal.iloveren.link/a.webp' },
          },
          { id: '..', display_name: 'Bad Id' },
        ],
      },
    },
    {
      body: {
        items: [
          {
            id: 'c1',
            cover_kind: 'main',
            url: 'https://image.kungal.iloveren.link/1.webp',
            width: 256,
            height: 356,
          },
          {
            id: 'c2',
            cover_kind: 'dig',
            url: 'https://image.kungal.iloveren.link/2.webp',
            width: null,
            height: null,
            portrait_pinned: true,
          },
          { id: 'c3', cover_kind: 'dig' },
        ],
      },
    },
  ])
  const works = await client.search('nextmoe', '作品')
  assert.deepEqual(works, [
    {
      kind: 'work',
      source: 'nextmoe',
      id: '15',
      title: '作品',
      subtitle: null,
      detail: '2016-07-29',
      previewUrl: 'https://image.kungal.iloveren.link/a.webp',
    },
  ])
  const covers = await client.listWorkCovers(works[0])
  assert.deepEqual(
    covers.map((cover) => [cover.id, cover.title, cover.subtitle, cover.detail]),
    [
      ['c2', '作品', 'dig', null],
      ['c1', '作品', 'main', '256×356'],
    ],
  )
  assert.equal(new URL(requests[1].url).pathname, '/v2/catalog/works/15/covers')
})

test('NextMoe 作品不存在时封面列表为空', async () => {
  const { client } = createClient([{ status: 404, body: { status: 404, code: 'NOT_FOUND' } }])
  const work = {
    kind: 'work',
    source: 'nextmoe',
    id: '9',
    title: 'Gone',
    subtitle: null,
    detail: null,
    previewUrl: null,
  }
  assert.deepEqual(await client.listWorkCovers(work), [])
})

test('NextMoe 的 429 和限流错误码都报 rate-limited', async () => {
  const { client } = createClient([
    { status: 429, body: '' },
    { status: 403, body: { code: 'QUOTA_EXCEEDED' } },
  ])
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(client.search('nextmoe', 'a'), (error) => {
      assert.ok(error instanceof PosterSearchError)
      assert.equal(error.code, 'rate-limited')
      return true
    })
  }
})

test('连不上、非 2xx 和格式不符分别报 network、service-error、bad-response', async () => {
  const { client } = createClient([
    new Error('ECONNRESET'),
    { status: 500, body: 'oops' },
    { status: 200, body: '<html></html>' },
  ])
  for (const code of ['network', 'service-error', 'bad-response']) {
    await assert.rejects(client.search('bangumi', 'a'), (error) => {
      assert.equal(error.source, 'bangumi')
      assert.equal(error.code, code)
      return true
    })
  }
})

test('同一来源的连续请求按最小间隔排队，不同来源互不影响', async () => {
  const empty = { body: { results: [] } }
  const { client, clock } = createClient([empty, empty, { body: { data: [] } }])
  await Promise.all([client.search('vndb', 'a'), client.search('vndb', 'b')])
  await client.search('bangumi', 'c')
  assert.deepEqual(clock.waits, [1550])
})

test('关键词为空白时不发请求', async () => {
  const { client, requests } = createClient([])
  assert.deepEqual(await client.search('vndb', '   '), [])
  assert.equal(requests.length, 0)
})

test('默认关键词去掉方括号括起来的部分', () => {
  assert.equal(createDefaultPosterKeyword('[社团] 游戏名 【汉化版】 '), '游戏名')
  assert.equal(createDefaultPosterKeyword(' [全部] '), '[全部]')
})

test('只允许 https 的白名单主机', () => {
  assert.equal(isPosterImageUrl('https://t.vndb.org/cv/1.jpg'), true)
  assert.equal(isPosterImageUrl('http://t.vndb.org/cv/1.jpg'), false)
  assert.equal(isPosterImageUrl('https://t.vndb.org.example.com/1.jpg'), false)
  assert.equal(isPosterImageUrl('https://user@t.vndb.org/1.jpg'), false)
  assert.equal(
    isPosterRequestAllowed({ method: 'GET', url: 'https://example.com/', headers: {}, body: null }),
    false,
  )
})
