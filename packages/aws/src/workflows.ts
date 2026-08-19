import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

/**
 * Start a Step Functions execution.
 *
 * Not a class implementing a port, because there is no port to implement: the
 * caller's seam is a `startSync(connectionId)` function it is handed, and this
 * is the one line of AWS behind it. Wrapping a single call in an interface, an
 * options object and a constructor would add three things and hide none.
 *
 * The name is truncated to Step Functions' 80-character limit. A name that is
 * too long is rejected at the API, which for the connect flow means the sync
 * never starts — and the deep-history window closes about an hour after the
 * authorisation, so a failure here costs history that no retry recovers.
 */
export async function startExecution(
  stateMachineArn: string,
  name: string,
  input: unknown,
  client: SFNClient = new SFNClient({}),
): Promise<void> {
  await client.send(
    new StartExecutionCommand({
      stateMachineArn,
      name: name.slice(0, 80),
      input: JSON.stringify(input),
    }),
  );
}
