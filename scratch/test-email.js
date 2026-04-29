import 'dotenv/config';
import nodemailer from 'nodemailer';

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;

console.log('Testing SMTP with:', {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    from: FROM_EMAIL
});

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
});

try {
    console.log('Verifying connection...');
    await transporter.verify();
    console.log('Connection successful!');
    
    console.log('Sending test email...');
    const info = await transporter.sendMail({
        from: `LIGMA Test <${FROM_EMAIL}>`,
        to: SMTP_USER, // send to self
        subject: 'LIGMA SMTP Test',
        text: 'If you see this, SMTP is working perfectly.',
    });
    console.log('Email sent successfully:', info.messageId);
} catch (err) {
    console.error('SMTP Error:', err);
}
