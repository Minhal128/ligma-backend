import nodemailer from 'nodemailer';
import crypto from 'crypto';

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export async function sendOTP(email, username, otp) {
  if (!transporter) {
    console.log(`[DEV MODE] OTP for ${username}: ${otp}`);
    return { success: true, devMode: true };
  }

  try {
    const data = await transporter.sendMail({
      from: `LIGMA <${FROM_EMAIL}>`,
      to: email,
      subject: 'Your LIGMA Verification Code',
      html: `
        <div style="font-family: monospace; max-width: 500px; margin: 0 auto; border: 4px solid #000; padding: 24px;">
          <h1 style="font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0 0 16px 0;">LIGMA</h1>
          <p style="font-size: 14px; font-weight: 700; margin: 0 0 8px 0;">Hello @${username},</p>
          <p style="font-size: 14px; font-weight: 700; margin: 0 0 16px 0;">Your verification code is:</p>
          <div style="background: #ff6b6b; border: 4px solid #000; padding: 16px; text-align: center; margin: 0 0 16px 0;">
            <span style="font-size: 32px; font-weight: 900; letter-spacing: 8px; font-family: monospace;">${otp}</span>
          </div>
          <p style="font-size: 12px; font-weight: 700; color: #666; margin: 0;">This code expires in 10 minutes.</p>
          <p style="font-size: 12px; font-weight: 700; color: #666; margin: 8px 0 0 0;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    return { success: true, data };
  } catch (err) {
    console.error('Failed to send email:', err);
    throw err;
  }
}

export async function sendPasswordReset(email, username, resetLink) {
  if (!transporter) {
    console.log(`[DEV MODE] Reset link for ${username}: ${resetLink}`);
    return { success: true, devMode: true };
  }

  try {
    const data = await transporter.sendMail({
      from: `LIGMA <${FROM_EMAIL}>`,
      to: email,
      subject: 'Reset Your LIGMA Password',
      html: `
        <div style="font-family: monospace; max-width: 500px; margin: 0 auto; border: 4px solid #000; padding: 24px;">
          <h1 style="font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0 0 16px 0;">LIGMA</h1>
          <p style="font-size: 14px; font-weight: 700; margin: 0 0 8px 0;">Hello @${username},</p>
          <p style="font-size: 14px; font-weight: 700; margin: 0 0 16px 0;">Click below to reset your password:</p>
          <a href="${resetLink}" style="display: inline-block; background: #ff6b6b; border: 4px solid #000; padding: 12px 24px; text-decoration: none; color: #000; font-weight: 900; font-size: 14px; text-transform: uppercase; margin: 0 0 16px 0;">RESET PASSWORD</a>
          <p style="font-size: 12px; font-weight: 700; color: #666; margin: 0;">This link expires in 1 hour.</p>
          <p style="font-size: 12px; font-weight: 700; color: #666; margin: 8px 0 0 0;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    return { success: true, data };
  } catch (err) {
    console.error('Failed to send email:', err);
    throw err;
  }
}

export function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function generateResetToken() {
  return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function generateInviteToken() {
  return crypto.randomBytes(24).toString('hex');
}

export async function sendRoomInvite(email, invitedBy, roomName, role, inviteUrl) {
  if (!transporter) {
    console.log(`[DEV MODE] Invite ${email} to "${roomName}" as ${role}: ${inviteUrl}`);
    return { success: true, devMode: true };
  }

  const data = await transporter.sendMail({
    from: `LIGMA <${FROM_EMAIL}>`,
    to: email,
    subject: `Workspace invite: ${roomName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 580px; margin: 0 auto;">
        <h2>You've been invited to LIGMA</h2>
        <p><strong>${invitedBy}</strong> invited you to join <strong>${roomName}</strong> as <strong>${role}</strong>.</p>
        <p style="margin-top: 24px;">
          <a href="${inviteUrl}" style="background:#111;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px;">
            Accept invite
          </a>
        </p>
      </div>
    `,
  });
  return { success: true, data };
}
