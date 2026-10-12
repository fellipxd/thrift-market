'use server';

import { actOnReport, moderateReview, reverseModerationAction } from '@thrift/application';
import { formObject, runAction, type ActionState } from '@/server/actions';

export async function actOnReportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => actOnReport(ctx, formObject(form)), 'Done. The affected person has been told why and how to appeal.');
}

export async function reverseModerationActionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => reverseModerationAction(ctx, formObject(form)), 'Reversed.');
}

export async function moderateReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction((ctx) => moderateReview(ctx, formObject(form)), 'Review updated.');
}
