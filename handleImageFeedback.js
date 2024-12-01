import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

// Add JWT verification function
const extractUserId = (authHeader) => {
  try {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("No valid Bearer token found in auth header");
      return null;
    }
    const token = authHeader.split(" ")[1];
    const decoded = Buffer.from(token.split(".")[1], "base64").toString();
    const payload = JSON.parse(decoded);
    return payload.username || null;
  } catch (error) {
    console.error("Error decoding JWT:", error);
    return null;
  }
};

// Add this at the top with other constants
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

// Add this utility function
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
  // Add CORS handling at the start of the handler
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

  // Handle OPTIONS request for CORS preflight
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

  // Extract userId from Authorization header
  const authHeader = event.headers.Authorization || event.headers.authorization;
  const userId = extractUserId(authHeader);

  if (!userId) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Valid authorization token is required" }),
    };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString()
    : event.body;

  console.log("Decoded body:", body);

  const { imageHash, feedbackType, comment } = JSON.parse(body);

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

    // If feedback type is the same, return early
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

    // Update feedback if it's different
    try {
      // Update the feedback entry
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

      // Update the counts in the cache table
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

  // If no existing feedback, continue with the original code for new feedback
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

    // Also update the count in the cache table
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
