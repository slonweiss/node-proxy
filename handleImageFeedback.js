const {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  const { imageHash, feedbackType, comment } = JSON.parse(event.body);

  // Update the main table (thumbs up/down count)
  const updateMainParams = {
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
    ReturnValues: "ALL_NEW",
  };

  // Add comment to the separate comment table
  const addCommentParams = {
    TableName: process.env.COMMENT_TABLE,
    Item: {
      ImageHash: { S: imageHash },
      CommentId: { S: uuidv4() },
      Comment: { S: comment },
      Timestamp: { S: new Date().toISOString() },
    },
  };

  try {
    await dynamoDBClient.send(new UpdateItemCommand(updateMainParams));
    await dynamoDBClient.send(new PutItemCommand(addCommentParams));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Feedback submitted successfully" }),
    };
  } catch (error) {
    console.error("Error submitting feedback:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to submit feedback" }),
    };
  }
};
