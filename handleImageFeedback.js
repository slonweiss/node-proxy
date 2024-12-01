import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { parse } from "lambda-multipart-parser";
import { jwtDecode } from "jwt-decode";

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
  console.log("Raw event:", {
    ...event,
    headers: event.headers,
    body: event.body,
    isBase64Encoded: event.isBase64Encoded,
    httpMethod: event.httpMethod,
  });

  const origin = getValidOrigin(event);
  console.log("Determined origin:", origin);

  const allowOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  // Try to get userId from multiple sources
  let userId;

  // First try to get from JWT token
  const authHeader = event.headers.Authorization || event.headers.authorization;
  console.log("All headers:", event.headers);
  console.log("Auth header (raw):", authHeader);

  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.split(" ")[1];
      console.log("Extracted token:", token?.substring(0, 20) + "...");

      const decodedToken = jwtDecode(token);
      console.log("Decoded token structure:", {
        keys: Object.keys(decodedToken),
        sub: decodedToken.sub,
        username: decodedToken.username,
        email: decodedToken.email,
      });

      userId = decodedToken.username || decodedToken.sub;
      console.log("Final determined userId:", userId);
    } catch (error) {
      console.error("Token decode error:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
        token: authHeader?.substring(0, 20) + "...",
      });
    }
  } else {
    console.log("No valid Bearer token found in Authorization header");
  }

  // Parse the body
  let parsedBody;
  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];
    console.log("Content-Type (raw):", contentType);

    if (contentType?.includes("multipart/form-data")) {
      console.log("Parsing as multipart/form-data");
      parsedBody = await parse(event);
    } else if (contentType?.includes("application/json")) {
      console.log("Parsing as application/json");
      if (event.isBase64Encoded) {
        const decodedBody = Buffer.from(event.body, "base64").toString();
        parsedBody = JSON.parse(decodedBody);
      } else {
        parsedBody = JSON.parse(event.body);
      }
    } else {
      console.log("Attempting to parse unknown content type as JSON");
      // Try to parse as JSON anyway
      parsedBody =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    }

    console.log("Final parsed body:", parsedBody);
  } catch (error) {
    console.error("Body parsing error:", {
      error: error.message,
      rawBody: event.body?.substring(0, 100) + "...",
      contentType:
        event.headers["content-type"] || event.headers["Content-Type"],
    });
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Invalid request body format",
        details: error.message,
        contentType:
          event.headers["content-type"] || event.headers["Content-Type"],
      }),
    };
  }

  const { imageHash, feedbackType, comment, userId: bodyUserId } = parsedBody;

  // If we didn't get userId from token, try to get it from body
  userId = userId || bodyUserId;

  // Final check for userId
  if (!userId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error:
          "Unable to determine user ID. Please ensure you are authenticated or provide a user ID.",
      }),
    };
  }

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

  console.log("Raw event:", event);
  console.log("Event body:", event.body);
  console.log("Is base64 encoded:", event.isBase64Encoded);

  if (feedbackType !== "up" && feedbackType !== "down") {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Invalid feedbackType. Must be "up" or "down".',
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
          "#newFeedbackType": feedbackType === "up" ? "ThumbsUp" : "ThumbsDown",
          "#oldFeedbackType": existingType === "up" ? "ThumbsUp" : "ThumbsDown",
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
};
