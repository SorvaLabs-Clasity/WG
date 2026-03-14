import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

let rawClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
});
export let docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export function resetDynamoClient(credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): void {
  rawClient.destroy();
  rawClient = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(credentials ? { credentials } : {}),
  });
  docClient = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function tableName(envVar: string): string {
  const name = process.env[envVar];
  if (!name) {
    throw new Error(`Missing required DynamoDB table env var: ${envVar}`);
  }
  return name;
}

export function usesDynamo(): boolean {
  return !!process.env.ACTIVITY_TABLE;
}

export {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
};
