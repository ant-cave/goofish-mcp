/* SPDX-License-Identifier: MIT */
/**
 * goofish-mcp 本地演示用 mock：模拟 /home/ant/dev/goofish-client/dist 的导出
 * 提供与真实 goofish-client 相同形状的 API：
 *  - api.mtop.search.search / api.mtop.item.getDetail（返回模拟数据）
 *  - api.passport.qr.generate / api.passport.qr.query（二维码流程）
 *  - getCookiePassport / updateCookieMtop
 * 演示模式下 qr.query 读到 DATA_DIR/mock-qr-confirmed 文件即返回 CONFIRMED，
 * 由 POST /admin/api/demo/confirm 写入该文件，实现完整扫码登录链路演示。
 */
const fs = require('fs');
const path = require('path');

const LogLevel = { ERROR: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'debug' };

const MOCK_ITEMS = [
  { itemId: '1045859220365', title: 'MacBook Pro 14 M1 Pro 16G/512G 深空灰', price: '¥ 6,299', desc: '自用无磕碰，循环 87 次，箱说全', seller: '数码君', browseCnt: 342, collectCnt: 56 },
  { itemId: '1088234512076', title: 'MacBook Air M2 午夜色 8G/256G', price: '¥ 4,850', desc: '学生党自用，屏幕无划痕，带原装充电器', seller: '小透明', browseCnt: 128, collectCnt: 19 },
  { itemId: '1054127890341', title: '闲鱼玩家 键盘 HHKB Professional HYBRID Type-S', price: '¥ 1,680', desc: '静电容 45g 压力，成色看图，包邮', seller: '外设老张', browseCnt: 89, collectCnt: 12 },
  { itemId: '1099451208732', title: 'iPad Pro 12.9 2021 256G WiFi 银色', price: '¥ 3,999', desc: '搭配 Apple Pencil 二代出，电池健康 94%', seller: '果粉一枚', browseCnt: 256, collectCnt: 41 },
  { itemId: '1077309182456', title: '索尼 WH-1000XM5 头戴式降噪耳机 银色', price: '¥ 1,299', desc: '出差两次，功能全部正常，降噪无敌', seller: '耳朵罢工', browseCnt: 77, collectCnt: 9 },
];

function toMtopItem(it) {
  return {
    data: {
      item: {
        itemId: it.itemId,
        main: {
          exContent: {
            title: it.title,
            price: [{ text: it.price }],
            desc: it.desc,
          },
        },
      },
    },
  };
}

class Goofish {
  constructor(opts = {}) {
    this.level = opts.level || LogLevel.ERROR;
    this.cookie = opts.cookie || null;
    const dataDir = process.env.GOOFISH_DATA_DIR || path.join(__dirname, '..', 'data');
    this.confirmFile = path.join(dataDir, 'mock-qr-confirmed');

    this.api = {
      mtop: {
        search: {
          search: async (params = {}) => {
            // 简单模拟：关键词命中标题，page/rows 切片
            const kw = params.keyword || '';
            const all = MOCK_ITEMS.filter((x) => !kw || x.title.includes(kw));
            const page = Math.max(1, params.pageNumber || 1);
            const rows = Math.max(1, params.rowsPerPage || 20);
            const start = (page - 1) * rows;
            const list = all.slice(start, start + rows).map(toMtopItem);
            return {
              ret: ['SUCCESS::调用成功'],
              data: { resultList: list, total: all.length },
            };
          },
        },
        item: {
          getDetail: async ({ itemId } = {}) => {
            const it = MOCK_ITEMS.find((x) => String(x.itemId) === String(itemId)) || MOCK_ITEMS[0];
            return {
              ret: ['SUCCESS::调用成功'],
              data: {
                itemDO: {
                  title: it.title,
                  soldPrice: it.price,
                  desc: it.desc,
                  browseCnt: it.browseCnt,
                  collectCnt: it.collectCnt,
                  imageInfos: [
                    { url: 'https://placehold.co/600x400/f5f5f5/737373?text=goofish-mock-1' },
                    { url: 'https://placehold.co/600x400/e5e5e5/737373?text=goofish-mock-2' },
                  ],
                },
                sellerDO: { nick: it.seller },
              },
            };
          },
        },
      },
      passport: {
        qr: {
          generate: async () => ({
            content: {
              success: true,
              data: {
                t: 'mock-t-' + Date.now(),
                ck: 'mock-ck',
                codeContent: 'https://xianyu.goofish.mock/qr?demo=1&t=' + Date.now(),
              },
            },
          }),
          query: async () => {
            let confirmed = false;
            try { confirmed = fs.existsSync(this.confirmFile); } catch (e) { /* ignore */ }
            return {
              content: {
                success: true,
                data: { qrCodeStatus: confirmed ? 'CONFIRMED' : 'NEW' },
              },
            };
          },
        },
      },
    };
  }

  getCookiePassport() {
    return 'MOCK_COOKIE_' + Buffer.from('goofish-demo-session').toString('base64');
  }

  updateCookieMtop(cookie) {
    this.cookie = cookie;
  }
}

module.exports = { Goofish, LogLevel };
