-- dm-images Storage bucket RLS policies
-- Chrome拡張が image_url を fetch するため、SELECT は public アクセス必要

-- INSERT policy for dm-images bucket
CREATE POLICY "Allow authenticated users to upload dm images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'dm-images' AND auth.role() = 'authenticated');

-- SELECT policy for dm-images bucket
CREATE POLICY "Allow public read access to dm images"
ON storage.objects FOR SELECT
USING (bucket_id = 'dm-images');
