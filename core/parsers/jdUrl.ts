const withDefaultProtocol = (input: string): string => {
  const value = input.trim();

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^(?:item\.)?(?:m\.)?jd\.com\//i.test(value) || /^item\.jd\.com\//i.test(value)) {
    return `https://${value}`;
  }

  return value;
};

export const extractJdSkuId = (input: string): string | null => {
  const normalizedInput = withDefaultProtocol(input);

  if (!normalizedInput) {
    return null;
  }

  const directMatch = normalizedInput.match(/(?:^|\/)(\d{5,})(?:\.html)?(?:[?#/]|$)/);

  if (directMatch) {
    return directMatch[1];
  }

  try {
    const url = new URL(normalizedInput);
    return url.searchParams.get('sku') || url.searchParams.get('skuId');
  } catch {
    return null;
  }
};

export const isJdProductUrl = (input: string): boolean => {
  const skuId = extractJdSkuId(input);

  if (!skuId) {
    return false;
  }

  try {
    const url = new URL(withDefaultProtocol(input));
    return /(^|\.)jd\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

export const normalizeJdProductUrl = (input: string): string => {
  const skuId = extractJdSkuId(input);

  if (!skuId) {
    throw new Error(`无法从链接中识别京东 SKU ID: ${input}`);
  }

  return `https://item.jd.com/${skuId}.html`;
};
