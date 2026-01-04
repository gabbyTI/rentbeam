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
  }
};
