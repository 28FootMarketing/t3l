-- Register the Community feature in the module on/off registry so a super admin
-- can toggle it from the console's Modules screen (default ON). The admin consoles
-- and the client portal hide their Community nav + view when this is disabled.
insert into public.t3l_portal_modules (key, enabled, label, sort)
values ('community', true, 'Community', 55)
on conflict (key) do nothing;
