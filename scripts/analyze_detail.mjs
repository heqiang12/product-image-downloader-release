import https from 'https';
import http from 'http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchUrl = (url, redirectCount = 0) => {
  if (redirectCount > 5) { console.log('Too many redirects'); return; }
  const lib = url.startsWith('https') ? https : http;
  const options = {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
  };
  lib.get(url, options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log('Redirect to:', res.headers.location);
      fetchUrl(res.headers.location, redirectCount + 1);
      return;
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      process(data, res.statusCode);
    });
  }).on('error', e => console.error('请求错误:', e.message));
};

const process = (data, statusCode) => {

  console.log('页面长度:', data.length);
  console.log('状态码:', statusCode);

  // 找所有 iframe
  const iframes = [...data.matchAll(/<iframe[^>]+>/gi)];
  iframes.forEach(m => console.log('IFRAME:', m[0].slice(0, 200)));

  // 找 description URL 关键词
  const descMatches = [...data.matchAll(/description[^<"']{0,100}/gi)];
  descMatches.slice(0, 5).forEach(m => console.log('DESC_HINT:', m[0].slice(0, 150)));

  // 找以 img 开头的图片链接
  const imgs = [...data.matchAll(/https?:\/\/img[^"'\s<]{5,}/g)];
  const imgSet = new Set(imgs.map(m => m[0].replace(/&amp;/g, '&').split('"')[0]));
  console.log('图片链接数量:', imgSet.size);
  [...imgSet].slice(0, 5).forEach(u => console.log('IMG:', u));

  // 找 detail 相关 id/class
  const detailNodes = [...data.matchAll(/id="([^"]*detail[^"]*)"/gi)];
  detailNodes.forEach(m => console.log('DETAIL_ID:', m[1]));

  // 找 functionId 或 api 调用
  const apiCalls = [...data.matchAll(/functionId[=:]['"]([^'"&]+)/gi)];
  apiCalls.slice(0, 10).forEach(m => console.log('API_FUNC:', m[1]));

  // 找京东描述接口相关配置
  const jdApiUrls = [...data.matchAll(/api\.m\.jd\.com\/[^"\'\s<]{10,}/g)];
  jdApiUrls.slice(0, 5).forEach(m => console.log('JD_API:', m[0]));
};

fetchUrl('https://item.jd.com/10092965124056.html');
