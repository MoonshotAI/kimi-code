export type SurveyKind = 'session' | 'long_context';

export type RatingResponse = 'bad' | 'fine' | 'good';

export type SurveyResponse = RatingResponse | 'dismissed';

export type SurveyEventType = 'appeared' | 'responded' | 'abandoned';

export interface RatingOffer {
  readonly appearanceId: string;
  readonly survey: SurveyKind;
}

export interface SurveyAppearance extends RatingOffer {
  readonly appearanceIndex: number;
}

export type RatingReport =
  | { readonly type: 'shown' | 'abandon'; readonly appearanceId: string }
  | { readonly type: 'respond'; readonly appearanceId: string; readonly response: SurveyResponse };

export interface RatingTrackContext {
  readonly sessionId: string;
}
