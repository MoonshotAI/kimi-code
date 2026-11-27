import { Type, type Static } from 'typebox';
import { defineBrowserValidator } from './browser-validator';

const ReceiptId = Type.String({ pattern: '^r-[0-9a-f]{12}$' });
const SessionId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' });
const Unit = Type.Number({ minimum: 0, maximum: 1 });
const Size = Type.Number({ exclusiveMinimum: 0, maximum: 100000 });
const ReceiptImage = Type.Object({
  id: ReceiptId,
  mimeType: Type.Literal('image/jpeg'),
  data: Type.String({ minLength: 1, maxLength: 16000000 }),
  width: Size,
  height: Size,
  point: Type.Optional(Type.Object({ x: Unit, y: Unit })),
  box: Type.Optional(Type.Object({ x: Unit, y: Unit, width: Unit, height: Unit })),
});

export type BrowserReceiptImage = Static<typeof ReceiptImage>;

export const browserValidators = {
  receiptId: defineBrowserValidator(ReceiptId),
  sessionId: defineBrowserValidator(SessionId),
  read: defineBrowserValidator(Type.Object({ sessionId: SessionId, receiptId: ReceiptId })),
  copy: defineBrowserValidator(Type.Object({ sourceId: SessionId, targetId: SessionId })),
  image: defineBrowserValidator(ReceiptImage),
};
