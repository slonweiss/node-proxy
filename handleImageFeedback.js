import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { parse } from "lambda-multipart-parser";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

const allowedOrigins = [
  "https://www.linkedin.com",
  "https://www.facebook.com",
  "https://www.twitter.com",
  "https://www.x.com",
  "https://www.instagram.com",
  "https://www.reddit.com",
  "https://realeyes.ai",
  "https://api.realeyes.ai",
];

const getValidOrigin = (event) => {
  const xOrigin = event.headers["x-origin"] || event.headers["X-Origin"];
  const origin = event.headers.origin || event.headers.Origin;
  const referer = event.headers.referer || event.headers.Referrer;

  // First check x-origin header
  if (xOrigin) {
    const xOriginDomain = new URL(xOrigin).origin;
    if (allowedOrigins.includes(xOriginDomain)) {
      return xOriginDomain;
    }
  }

  // Then check regular origin
  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }

  // Finally check referer
  if (referer) {
    for (const allowedOrigin of allowedOrigins) {
      if (referer.startsWith(allowedOrigin)) {
        return allowedOrigin;
      }
    }
  }

  // If no valid origin is found, return null
  return null;
};

export const handler = async (event) => {
  const origin = getValidOrigin(event);
  const allowOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Access-Control-Max-Age": "86400",
      },
      body: "",
    };
  }

  try {
    // Decode the base64 body if necessary
    const decodedBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("binary")
      : event.body;

    console.log("Is base64 encoded:", event.isBase64Encoded);
    console.log("Decoded body:", decodedBody);

    // Parse the multipart form data
    const result = await parse({
      ...event,
      body: decodedBody,
      isBase64Encoded: false, // Since we've already decoded it
    });

    // Extract feedback data from the parsed result
    const feedbackData = JSON.parse(result.feedback);
    const { imageHash, feedbackType, comment } = feedbackData;

    // Try to get userId from JWT token
    let userId;
    const authHeader =
      event.headers.Authorization || event.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const decodedToken = jwt_decode(token);
        userId = decodedToken.username || decodedToken.sub;
      } catch (error) {
        console.warn("Warning: Failed to decode token:", error);
      }
    }

    // If we didn't get userId from token, return error
    if (!userId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error:
            "Unable to determine user ID. Please ensure you are authenticated.",
        }),
      };
    }

    // Check if user has already submitted feedback for this image
    const existingFeedback = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: process.env.COMMENT_TABLE,
        Key: {
          ImageHash: { S: imageHash },
          UserId: { S: userId },
        },
      })
    );

    if (existingFeedback.Item) {
      const existingType = existingFeedback.Item.Type.S;

      if (existingType === feedbackType) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Feedback already received",
            imageHash: imageHash,
            userId: userId,
            feedbackType: feedbackType,
          }),
        };
      }

      try {
        const updateFeedbackParams = {
          TableName: process.env.COMMENT_TABLE,
          Key: {
            ImageHash: { S: imageHash },
            UserId: { S: userId },
          },
          UpdateExpression:
            "SET #type = :newType, #comment = :newComment, #timestamp = :newTimestamp",
          ExpressionAttributeNames: {
            "#type": "Type",
            "#comment": "Comment",
            "#timestamp": "Timestamp",
          },
          ExpressionAttributeValues: {
            ":newType": { S: feedbackType },
            ":newComment": { S: comment || "" },
            ":newTimestamp": { S: new Date().toISOString() },
          },
        };

        await dynamoDBClient.send(new UpdateItemCommand(updateFeedbackParams));

        const updateCountParams = {
          TableName: process.env.DYNAMODB_TABLE,
          Key: {
            ImageHash: { S: imageHash },
          },
          UpdateExpression: "ADD #newFeedbackType :inc, #oldFeedbackType :dec",
          ExpressionAttributeNames: {
            "#newFeedbackType":
              feedbackType === "up" ? "ThumbsUp" : "ThumbsDown",
            "#oldFeedbackType":
              existingType === "up" ? "ThumbsUp" : "ThumbsDown",
          },
          ExpressionAttributeValues: {
            ":inc": { N: "1" },
            ":dec": { N: "-1" },
          },
        };

        await dynamoDBClient.send(new UpdateItemCommand(updateCountParams));

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Feedback updated successfully",
            imageHash: imageHash,
            userId: userId,
            feedbackType: feedbackType,
            previousFeedback: existingType,
          }),
        };
      } catch (error) {
        console.error("Error updating feedback:", error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Failed to update feedback" }),
        };
      }
    }

    const putParams = {
      TableName: process.env.COMMENT_TABLE,
      Item: {
        ImageHash: { S: imageHash },
        UserId: { S: userId },
        Type: { S: feedbackType },
        Comment: { S: comment || "" },
        Timestamp: { S: new Date().toISOString() },
      },
    };

    try {
      await dynamoDBClient.send(new PutItemCommand(putParams));

      const updateCountParams = {
        TableName: process.env.DYNAMODB_TABLE,
        Key: {
          ImageHash: { S: imageHash },
        },
        UpdateExpression: "ADD #feedbackType :inc",
        ExpressionAttributeNames: {
          "#feedbackType": feedbackType === "up" ? "ThumbsUp" : "ThumbsDown",
        },
        ExpressionAttributeValues: {
          ":inc": { N: "1" },
        },
      };

      await dynamoDBClient.send(new UpdateItemCommand(updateCountParams));

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "Feedback submitted successfully",
          imageHash: imageHash,
          userId: userId,
          feedbackType: feedbackType,
        }),
      };
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        return {
          statusCode: 409,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "User has already submitted feedback for this image",
          }),
        };
      }

      console.error("Error submitting feedback:", error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Failed to submit feedback" }),
      };
    }
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to process request" }),
    };
  }
};
