import nodemailer from 'nodemailer';
import logger from '../lib/logger.js';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025'),
  secure: false,
  ignoreTLS: true,
});

export const emailService = {
  async sendTenantInvite(email: string, landlordName: string, inviteToken: string): Promise<void> {
    const inviteLink = `${process.env.FRONTEND_URL}/invite/${inviteToken}`;

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: email,
        subject: `You've been invited to RentTrack by ${landlordName}`,
        html: `
          <h2>Welcome to RentTrack!</h2>
          <p>${landlordName} has invited you to join as a tenant.</p>
          <p>Click the link below to accept the invite and set up your account:</p>
          <a href="${inviteLink}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">Accept Invite</a>
          <p>Or copy and paste this link into your browser:</p>
          <p>${inviteLink}</p>
          <hr>
          <p style="color: #666; font-size: 12px;">If you didn't expect this email, you can safely ignore it.</p>
        `,
        text: `
You've been invited to RentTrack by ${landlordName}!

Click this link to accept the invite and set up your account:
${inviteLink}

If you didn't expect this email, you can safely ignore it.
        `
      });

      logger.info({ email, inviteLink }, '📧 Invite email sent');
    } catch (error) {
      logger.error({ error, email }, 'Failed to send invite email');
      throw error;
    }
  },

  async sendPaymentSuccessEmail(params: {
    email: string;
    tenantName: string;
    rentAmount: string;
    processingFee: string;
    totalAmount: string;
    paymentDate: string;
    propertyName: string;
    unitName: string;
  }): Promise<void> {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: params.email,
        subject: 'Payment Successful - Rent Payment Received',
        html: `
          <h2>✅ Payment Received</h2>
          <p>Hi ${params.tenantName},</p>
          <p>Your rent payment has been successfully processed!</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Payment Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0;"><strong>Property:</strong></td>
                <td style="text-align: right;">${params.propertyName} - Unit ${params.unitName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>Rent Amount:</strong></td>
                <td style="text-align: right;">$${params.rentAmount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>Processing Fee:</strong></td>
                <td style="text-align: right;">$${params.processingFee}</td>
              </tr>
              <tr style="border-top: 2px solid #d1d5db;">
                <td style="padding: 8px 0;"><strong>Total Paid:</strong></td>
                <td style="text-align: right;"><strong>$${params.totalAmount}</strong></td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>Date:</strong></td>
                <td style="text-align: right;">${params.paymentDate}</td>
              </tr>
            </table>
          </div>

          <p>Thank you for using RentTrack!</p>
          <hr>
          <p style="color: #666; font-size: 12px;">Questions? Contact your landlord or visit your dashboard.</p>
        `,
        text: `
Payment Received ✅

Hi ${params.tenantName},

Your rent payment has been successfully processed!

Payment Details:
Property: ${params.propertyName} - Unit ${params.unitName}
Rent Amount: $${params.rentAmount}
Processing Fee: $${params.processingFee}
Total Paid: $${params.totalAmount}
Date: ${params.paymentDate}

Thank you for using RentTrack!
        `
      });

      logger.info({ email: params.email }, '📧 Payment success email sent');
    } catch (error) {
      logger.error({ error, email: params.email }, 'Failed to send payment success email');
      // Don't throw - email failure shouldn't break payment processing
    }
  },

  async sendPaymentFailedEmail(params: {
    email: string;
    tenantName: string;
    rentAmount: string;
    errorMessage: string;
    propertyName: string;
    unitName: string;
    isAutopay: boolean;
    failureCount?: number;
  }): Promise<void> {
    const retryMessage = params.failureCount 
      ? `This is attempt ${params.failureCount} of 3. After 3 failed attempts, autopay will be automatically disabled.`
      : '';

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: params.email,
        subject: '⚠️ Payment Failed - Action Required',
        html: `
          <h2>⚠️ Payment Failed</h2>
          <p>Hi ${params.tenantName},</p>
          <p>We were unable to process your ${params.isAutopay ? 'autopay' : ''} rent payment.</p>
          
          <div style="background-color: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
            <h3 style="margin-top: 0; color: #991b1b;">Payment Details</h3>
            <p><strong>Property:</strong> ${params.propertyName} - Unit ${params.unitName}</p>
            <p><strong>Amount:</strong> $${params.rentAmount}</p>
            <p><strong>Error:</strong> ${params.errorMessage}</p>
            ${retryMessage ? `<p style="color: #991b1b; font-weight: bold; margin-top: 12px;">⚠️ ${retryMessage}</p>` : ''}
          </div>

          <p><strong>What to do next:</strong></p>
          <ul>
            <li>Check that your payment method is valid and has sufficient funds</li>
            <li>Update your payment method in your dashboard if needed</li>
            ${params.isAutopay ? '<li>We will automatically retry on the next scheduled autopay run</li>' : '<li>Try paying again or contact your landlord</li>'}
          </ul>

          <a href="${process.env.FRONTEND_URL}/tenant/dashboard" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">Go to Dashboard</a>

          <hr>
          <p style="color: #666; font-size: 12px;">Need help? Contact your landlord immediately.</p>
        `,
        text: `
Payment Failed ⚠️

Hi ${params.tenantName},

We were unable to process your ${params.isAutopay ? 'autopay' : ''} rent payment.

Payment Details:
Property: ${params.propertyName} - Unit ${params.unitName}
Amount: $${params.rentAmount}
Error: ${params.errorMessage}
${retryMessage ? `\n⚠️ ${retryMessage}` : ''}

What to do next:
- Check that your payment method is valid and has sufficient funds
- Update your payment method in your dashboard if needed
${params.isAutopay ? '- We will automatically retry on the next scheduled autopay run' : '- Try paying again or contact your landlord'}

Go to Dashboard: ${process.env.FRONTEND_URL}/tenant/dashboard
        `
      });

      logger.info({ email: params.email }, '📧 Payment failed email sent');
    } catch (error) {
      logger.error({ error, email: params.email }, 'Failed to send payment failed email');
    }
  },

  async sendAutopayDisabledEmail(params: {
    email: string;
    tenantName: string;
    reason: string;
    propertyName: string;
    unitName: string;
  }): Promise<void> {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: params.email,
        subject: 'Autopay Disabled - Action Required',
        html: `
          <h2>🔔 Autopay Disabled</h2>
          <p>Hi ${params.tenantName},</p>
          <p>Your autopay for ${params.propertyName} - Unit ${params.unitName} has been disabled.</p>
          
          <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <p><strong>Reason:</strong> ${params.reason}</p>
          </div>

          <p><strong>What this means:</strong></p>
          <ul>
            <li>Your rent will no longer be automatically charged</li>
            <li>You'll need to manually pay your rent each month</li>
            <li>Update your payment method to re-enable autopay</li>
          </ul>

          <a href="${process.env.FRONTEND_URL}/tenant/autopay" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">Update Payment Method</a>

          <hr>
          <p style="color: #666; font-size: 12px;">You can re-enable autopay anytime from your dashboard.</p>
        `,
        text: `
Autopay Disabled 🔔

Hi ${params.tenantName},

Your autopay for ${params.propertyName} - Unit ${params.unitName} has been disabled.

Reason: ${params.reason}

What this means:
- Your rent will no longer be automatically charged
- You'll need to manually pay your rent each month
- Update your payment method to re-enable autopay

Update Payment Method: ${process.env.FRONTEND_URL}/tenant/autopay
        `
      });

      logger.info({ email: params.email }, '📧 Autopay disabled email sent');
    } catch (error) {
      logger.error({ error, email: params.email }, 'Failed to send autopay disabled email');
    }
  },

  async sendPaymentMethodSavedEmail(params: {
    email: string;
    tenantName: string;
    paymentMethodLabel: string;
    propertyName: string;
    unitName: string;
  }): Promise<void> {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: params.email,
        subject: 'Payment Method Added Successfully',
        html: `
          <h2>✅ Payment Method Saved</h2>
          <p>Hi ${params.tenantName},</p>
          <p>Your payment method has been successfully added to your account!</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Property:</strong> ${params.propertyName} - Unit ${params.unitName}</p>
            <p><strong>Payment Method:</strong> ${params.paymentMethodLabel}</p>
          </div>

          <p>You can now:</p>
          <ul>
            <li>Pay your rent online with one click</li>
            <li>Enable autopay for automatic monthly payments</li>
            <li>Update or remove your card anytime</li>
          </ul>

          <a href="${process.env.FRONTEND_URL}/tenant/dashboard" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">Go to Dashboard</a>

          <hr>
          <p style="color: #666; font-size: 12px;">Your card details are securely stored by Stripe.</p>
        `,
        text: `
Payment Method Saved ✅

Hi ${params.tenantName},

Your payment method has been successfully added to your account!

Property: ${params.propertyName} - Unit ${params.unitName}
Payment Method: ${params.paymentMethodLabel}

You can now:
- Pay your rent online with one click
- Enable autopay for automatic monthly payments
- Update or remove your card anytime

Go to Dashboard: ${process.env.FRONTEND_URL}/tenant/dashboard
        `
      });

      logger.info({ email: params.email }, '📧 Payment method saved email sent');
    } catch (error) {
      logger.error({ error, email: params.email }, 'Failed to send payment method saved email');
    }
  },

  async sendEmailVerificationCode(email: string, code: string, userName: string): Promise<void> {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: email,
        subject: 'Verify Your New Email Address',
        html: `
          <h2>Email Verification Code</h2>
          <p>Hi ${userName},</p>
          <p>You requested to change your email address. Please use the code below to verify your new email:</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
            <h1 style="font-size: 32px; letter-spacing: 8px; margin: 0; color: #4F46E5;">${code}</h1>
          </div>

          <p>This code will expire in 10 minutes.</p>
          
          <p><strong>If you didn't request this change, please ignore this email and your account will remain secure.</strong></p>

          <hr>
          <p style="color: #666; font-size: 12px;">This is an automated email from RentTrack. Please do not reply.</p>
        `,
        text: `
Email Verification Code

Hi ${userName},

You requested to change your email address. Please use the code below to verify your new email:

${code}

This code will expire in 10 minutes.

If you didn't request this change, please ignore this email and your account will remain secure.
        `
      });

      logger.info({ email }, '📧 Email verification code sent');
    } catch (error) {
      logger.error({ error, email }, 'Failed to send email verification code');
      throw error;
    }
  },

  async sendNotificationEmailVerification(email: string, code: string, userName: string): Promise<void> {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'noreply@renttrack.app',
        to: email,
        subject: 'Verify Your Notification Email - RentTrack',
        html: `
          <h2>📧 Verify Your Notification Email</h2>
          <p>Hi ${userName},</p>
          <p>You requested to set this email address as your notification email for payment alerts and updates.</p>
          
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
            <h3 style="margin-top: 0;">Your Verification Code</h3>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #4F46E5; padding: 20px; background-color: white; border-radius: 8px; display: inline-block;">
              ${code}
            </div>
          </div>

          <p>Enter this code in the RentTrack app to confirm your notification email address.</p>
          <p><strong>This code will expire in 15 minutes.</strong></p>

          <hr>
          <p style="color: #666; font-size: 12px;">If you didn't request this change, please ignore this email. Your notification email will not be changed.</p>
        `,
        text: `
Verify Your Notification Email

Hi ${userName},

You requested to set this email address as your notification email for payment alerts and updates.

Your Verification Code: ${code}

Enter this code in the RentTrack app to confirm your notification email address.

This code will expire in 15 minutes.

If you didn't request this change, please ignore this email. Your notification email will not be changed.
        `
      });

      logger.info({ email }, '📧 Notification email verification code sent');
    } catch (error) {
      logger.error({ error, email }, 'Failed to send notification email verification code');
      throw error;
    }
  },
};
