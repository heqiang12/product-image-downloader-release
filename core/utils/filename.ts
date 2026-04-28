const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export const sanitizeFilenamePart = (value: string, fallback = 'untitled'): string => {
  const sanitized = value
    .replace(INVALID_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  const safeValue = sanitized || fallback;
  const normalizedValue = WINDOWS_RESERVED_NAMES.test(safeValue) ? `_${safeValue}` : safeValue;

  return normalizedValue.slice(0, 80);
};

export const buildProductFolderName = (title: string, skuId: string): string =>
  sanitizeFilenamePart(`${title}_${skuId}`, `jd_${skuId}`);

export const getExtensionFromContentType = (contentType: string): string | null => {
  const normalizedType = contentType.split(';')[0]?.trim().toLowerCase();

  switch (normalizedType) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/avif':
      return '.avif';
    case 'image/bmp':
      return '.bmp';
    default:
      return null;
  }
};

export const getExtensionFromUrl = (url: string): string | null => {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(avif|bmp|gif|jpe?g|png|webp)$/i);

    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : null;
  } catch {
    return null;
  }
};

export const buildAssetFilename = (prefix: string, index: number, extension: string): string => {
  const serial = String(index).padStart(3, '0');
  return `${sanitizeFilenamePart(prefix, 'image')}_${serial}${extension}`;
};
