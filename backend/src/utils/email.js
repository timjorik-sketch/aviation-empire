import { Resend } from 'resend';

let cachedClient = null;

function getClient() {
  if (cachedClient !== null) return cachedClient;
  const apiKey = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  if (!apiKey) {
    cachedClient = false;
    return false;
  }
  cachedClient = new Resend(apiKey);
  return cachedClient;
}

export async function sendEmail({ to, subject, html, text }) {
  const client = getClient();
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Apron Empire <noreply@apronempire.com>';

  if (!client) {
    console.warn('[email] RESEND_API_KEY not configured — skipping send. Payload:');
    console.warn(`  to: ${to}\n  subject: ${subject}\n  text: ${text}`);
    return { skipped: true };
  }

  const { data, error } = await client.emails.send({ from, to, subject, html, text });
  if (error) throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  return { messageId: data?.id };
}

export async function sendVerificationEmail({ to, username, verifyUrl }) {
  const subject = 'Apron Empire — please verify your email';
  const text = [
    `Hi ${username || 'there'},`,
    '',
    'Welcome to Apron Empire! Please confirm that this is your email address by opening the link below within 7 days:',
    '',
    verifyUrl,
    '',
    "Verifying your email ensures you can recover your account if you ever forget your password.",
    '',
    '— Apron Empire',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C2C2C;line-height:1.5;">
      <h2 style="margin:0 0 16px;">Welcome to Apron Empire!</h2>
      <p>Hi ${username || 'there'},</p>
      <p>Please confirm this is your email address — it'll make sure you can recover your account later.</p>
      <p style="margin:24px 0;">
        <a href="${verifyUrl}"
           style="background:#2C2C2C;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">
          Verify email
        </a>
      </p>
      <p style="font-size:13px;color:#666;">Or copy this URL into your browser:<br>
        <a href="${verifyUrl}" style="color:#2C2C2C;">${verifyUrl}</a>
      </p>
      <p style="font-size:13px;color:#666;margin-top:24px;">This link is valid for 7 days.</p>
      <p style="font-size:12px;color:#999;margin-top:24px;">— Apron Empire</p>
    </div>
  `;

  return sendEmail({ to, subject, html, text });
}

export async function sendPasswordResetEmail({ to, username, resetUrl }) {
  const subject = 'Apron Empire — password reset request';
  const text = [
    `Hi ${username || 'there'},`,
    '',
    'We received a request to reset the password for your Apron Empire account.',
    'If that was you, open this link within 1 hour to choose a new password:',
    '',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password will stay the same.",
    '',
    '— Apron Empire',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C2C2C;line-height:1.5;">
      <h2 style="margin:0 0 16px;">Password reset request</h2>
      <p>Hi ${username || 'there'},</p>
      <p>We received a request to reset the password for your Apron Empire account.</p>
      <p>If that was you, click the button below within the next hour to choose a new password:</p>
      <p style="margin:24px 0;">
        <a href="${resetUrl}"
           style="background:#2C2C2C;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">
          Reset password
        </a>
      </p>
      <p style="font-size:13px;color:#666;">Or copy this URL into your browser:<br>
        <a href="${resetUrl}" style="color:#2C2C2C;">${resetUrl}</a>
      </p>
      <p style="font-size:13px;color:#666;margin-top:24px;">
        If you didn't request this, you can safely ignore this email — your password will stay the same.
      </p>
      <p style="font-size:12px;color:#999;margin-top:24px;">— Apron Empire</p>
    </div>
  `;

  return sendEmail({ to, subject, html, text });
}
