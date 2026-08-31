/**
 * SNS.
 *
 * The adapter for `Notifications`. Publish only — an application that could
 * subscribe an address could also unsubscribe one, and there is nothing it needs
 * that for.
 */

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { Notifications } from "@tightarse/domain";

export interface SnsNotificationsOptions {
  readonly topicArn: string;
  readonly client?: SNSClient;
  readonly region?: string;
}

export class SnsNotifications implements Notifications {
  private readonly sns: SNSClient;
  private readonly topicArn: string;

  constructor(opts: SnsNotificationsOptions) {
    this.topicArn = opts.topicArn;
    this.sns = opts.client ?? new SNSClient(opts.region ? { region: opts.region } : {});
  }

  async publish(subject: string, message: string): Promise<void> {
    await this.sns.send(
      new PublishCommand({ TopicArn: this.topicArn, Subject: subject, Message: message }),
    );
  }
}
