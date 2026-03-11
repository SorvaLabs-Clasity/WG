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

const isProduction = process.env.NODE_ENV === "production";

const rawClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export function tableName(envVar: string): string {
  const name = process.env[envVar];
  if (!name && isProduction) {
    throw new Error(`Missing required DynamoDB table env var: ${envVar}`);
  }
  return name || "";
}

export function usesDynamo(): boolean {
  return isProduction && !!process.env.ACTIVITY_TABLE;
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
