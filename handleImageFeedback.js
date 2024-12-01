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

export const handler = async (event) => {
  console.log("Raw event:", event);
  console.log("Event body:", event.body);
  console.log("Is base64 encoded:", event.isBase64Encoded);

  // Extract userId from Authorization header
  const authHeader = event.headers.Authorization || event.headers.authorization;
  const userId = extractUserId(authHeader);

  if (!userId) {
    return {
      statusCode: 401,
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
        body: JSON.stringify({
          error: "User has already submitted feedback for this image",
        }),
      };
    }

    console.error("Error submitting feedback:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to submit feedback" }),
    };
  }
};
