import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  ChangePasswordCommand,
  GlobalSignOutCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  GetUserAttributeVerificationCodeCommand,
  VerifyUserAttributeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHmac } from 'crypto';

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET!;

export const cognitoService = {
  // Create a new Cognito user (for landlord signup and tenant invite accept)
  async createUser(email: string, password: string, name: string) {
    // Use SignUpCommand to create user that requires email verification
    const signUpCommand = new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      SecretHash: this.generateSecretHash(email),
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'name', Value: name },
      ],
    });

    const result = await client.send(signUpCommand);
    const cognitoId = result.UserSub;

    if (!cognitoId) {
      throw new Error('Failed to create Cognito user');
    }

    return cognitoId;
  },

  // Create tenant user with pre-verified email (for invite acceptance)
  async createTenantUser(email: string, password: string, name: string) {
    // Use AdminCreateUserCommand with pre-verified email
    const createUserCommand = new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      MessageAction: 'SUPPRESS', // Don't send welcome email
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' }, // Mark email as verified
        { Name: 'name', Value: name },
      ],
    });

    const result = await client.send(createUserCommand);
    const cognitoId = result.User?.Attributes?.find(attr => attr.Name === 'sub')?.Value;

    if (!cognitoId) {
      throw new Error('Failed to create tenant user');
    }

    // Set permanent password
    const setPasswordCommand = new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      Password: password,
      Permanent: true,
    });

    await client.send(setPasswordCommand);

    return cognitoId;
  },

  // Login user (called from backend for testing, but frontend should call Cognito directly)
  async login(email: string, password: string) {
    const command = new AdminInitiateAuthCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthFlow: 'ADMIN_NO_SRP_AUTH',
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: this.generateSecretHash(email),
      },
    });

    const result = await client.send(command);
    return result.AuthenticationResult;
  },

  // Helper to generate secret hash for Cognito
  generateSecretHash(username: string): string {
    return createHmac('SHA256', CLIENT_SECRET)
      .update(username + CLIENT_ID)
      .digest('base64');
  },

  // Refresh access tokens using refresh token
  // Note: cognitoId (sub) required for SECRET_HASH computation
  async refreshTokens(refreshToken: string, cognitoId: string) {
    const command = new InitiateAuthCommand({
      ClientId: CLIENT_ID,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
        SECRET_HASH: this.generateSecretHash(cognitoId),
      },
    });

    const result = await client.send(command);
    return result.AuthenticationResult;
  },

  // Initiate forgot password flow - sends verification code to email
  async forgotPassword(email: string) {
    const command = new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      SecretHash: this.generateSecretHash(email),
    });

    await client.send(command);
  },

  // Confirm forgot password with verification code
  async resetPassword(email: string, code: string, newPassword: string) {
    const command = new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
      SecretHash: this.generateSecretHash(email),
    });

    await client.send(command);
  },

  // Change password for authenticated user
  async changePassword(accessToken: string, oldPassword: string, newPassword: string) {
    const command = new ChangePasswordCommand({
      AccessToken: accessToken,
      PreviousPassword: oldPassword,
      ProposedPassword: newPassword,
    });

    await client.send(command);
  },

  // Sign out user globally (revokes all tokens)
  async logout(accessToken: string) {
    const command = new GlobalSignOutCommand({
      AccessToken: accessToken,
    });

    await client.send(command);
  },

  // Check if user exists in Cognito
  async userExists(email: string): Promise<boolean> {
    try {
      const command = new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        MessageAction: 'SUPPRESS',
      });
      
      // This will throw if user doesn't exist
      // But we don't actually want to create, just check
      // In reality, use AdminGetUser command
      return false; // Placeholder - implement proper check
    } catch (error: any) {
      if (error.name === 'UsernameExistsException') {
        return true;
      }
      return false;
    }
  },

  async resendConfirmationCode(email: string): Promise<void> {
    const command = new ResendConfirmationCodeCommand({
      ClientId: CLIENT_ID,
      Username: email,
      SecretHash: this.generateSecretHash(email),
    });

    await client.send(command);
  },

  // Confirm email with verification code
  async confirmEmail(email: string, code: string): Promise<void> {
    const command = new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      SecretHash: this.generateSecretHash(email),
    });

    await client.send(command);
  },

  // Delete user from Cognito (for move-out/account deletion)
  async deleteUser(email: string): Promise<void> {
    const command = new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
    });

    await client.send(command);
  },

  // Update user email in Cognito and send verification code
  async updateUserEmail(oldEmail: string, newEmail: string, accessToken: string): Promise<void> {
    // Step 1: Update the email attribute (sets it as unverified)
    const updateCommand = new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: oldEmail, // Username is still the old email
      UserAttributes: [
        { Name: 'email', Value: newEmail },
        // email_verified will be set to false by Cognito, requiring verification
      ],
    });

    await client.send(updateCommand);
    
    // Step 2: Request verification code to be sent to new email
    const verifyCommand = new GetUserAttributeVerificationCodeCommand({
      AccessToken: accessToken,
      AttributeName: 'email',
    });
    
    await client.send(verifyCommand);
  },

  // Update email in Cognito with verified status (after our OTP verification)
  async updateUserEmailVerified(oldEmail: string, newEmail: string): Promise<void> {
    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: oldEmail,
      UserAttributes: [
        { Name: 'email', Value: newEmail },
        { Name: 'email_verified', Value: 'true' }, // Mark as verified since we verified via OTP
      ],
    });

    await client.send(command);
  },

  // Verify email attribute with verification code
  async verifyEmailAttribute(accessToken: string, code: string): Promise<void> {
    const command = new VerifyUserAttributeCommand({
      AccessToken: accessToken,
      AttributeName: 'email',
      Code: code,
    });

    await client.send(command);
  }
};
