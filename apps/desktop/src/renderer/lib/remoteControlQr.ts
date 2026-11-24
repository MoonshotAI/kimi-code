import QRCode from 'qrcode';

export async function createRemoteControlQrDataUrl(url: string): Promise<string | undefined> {
  try {
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 136,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch {
    return undefined;
  }
}
