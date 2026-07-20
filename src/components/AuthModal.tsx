import React, { useState } from 'react';
import { 
  X, Mail, Lock, User, Phone, MapPin, Shield, Sparkles, LogOut, CheckCircle, Edit
} from 'lucide-react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut,
  updateProfile
} from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  userProfile: any;
  onShowNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
  onRefreshProfile: () => Promise<void>;
}

export default function AuthModal({
  isOpen,
  onClose,
  userProfile,
  onShowNotification,
  onRefreshProfile
}: AuthModalProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [loading, setLoading] = useState(false);

  // Auth Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<'buyer' | 'admin'>('buyer');

  // Edit Profile State
  const [editName, setEditName] = useState(userProfile?.displayName || '');
  const [editPhone, setEditPhone] = useState(userProfile?.phone || '');
  const [editAddress, setEditAddress] = useState(userProfile?.address || '');

  if (!isOpen) return null;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isLogin) {
        // Sign In
        if (!email || !password) {
          onShowNotification('Please fill in email and password.', 'warning');
          setLoading(false);
          return;
        }
        await signInWithEmailAndPassword(auth, email, password);
        onShowNotification('Signed in successfully!', 'success');
        await onRefreshProfile();
        onClose();
      } else {
        // Sign Up
        if (!email || !password || !name) {
          onShowNotification('Please fill in required fields (Name, Email, Password).', 'warning');
          setLoading(false);
          return;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        // Set Auth Display Name
        await updateProfile(user, { displayName: name });

        // Save User document in Firestore
        await setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          email: user.email,
          displayName: name,
          role: role,
          phone: phone || '',
          address: address || '',
          createdAt: new Date().toISOString()
        });

        onShowNotification(`Account created successfully as ${role === 'admin' ? 'Admin' : 'Buyer'}!`, 'success');
        await onRefreshProfile();
        onClose();
      }
    } catch (error: any) {
      console.error('Auth error:', error);
      let errMsg = 'Authentication failed. Please check credentials.';
      if (error.code === 'auth/email-already-in-use') {
        errMsg = 'The email address is already in use.';
      } else if (error.code === 'auth/weak-password') {
        errMsg = 'The password must be at least 6 characters.';
      } else if (error.code === 'auth/invalid-credential') {
        errMsg = 'Invalid email or password.';
      }
      onShowNotification(errMsg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) {
      onShowNotification('Display Name cannot be empty.', 'warning');
      return;
    }

    setLoading(true);
    try {
      const user = auth.currentUser;
      if (user) {
        // Update Auth profile displayName
        await updateProfile(user, { displayName: editName });

        // Update Firestore profile
        await updateDoc(doc(db, 'users', user.uid), {
          displayName: editName,
          phone: editPhone,
          address: editAddress
        });

        onShowNotification('Profile updated successfully!', 'success');
        await onRefreshProfile();
        setIsEditingProfile(false);
      }
    } catch (error: any) {
      console.error('Profile update error:', error);
      onShowNotification('Failed to update profile.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      onShowNotification('Signed out successfully.', 'success');
      await onRefreshProfile();
      onClose();
    } catch (error) {
      onShowNotification('Error signing out.', 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        
        {/* Backdrop overlay */}
        <div className="fixed inset-0 bg-black/45 backdrop-blur-xs transition-opacity" onClick={onClose} />

        {/* Trick to center the modal */}
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

        {/* Modal content container */}
        <div className="relative inline-block align-middle bg-white rounded-2xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:max-w-md sm:w-full border border-gray-100">
          
          {/* Header */}
          <div className="bg-emerald-600 px-6 py-5 flex items-center justify-between text-white">
            <div className="flex items-center space-x-2">
              <Sparkles className="w-5 h-5 text-emerald-100" />
              <h3 className="text-lg font-bold font-sans">
                {userProfile 
                  ? 'Your Account Profile' 
                  : isLogin 
                    ? 'Welcome Back' 
                    : 'Create Your Account'
                }
              </h3>
            </div>
            <button 
              onClick={onClose}
              className="p-1 rounded-full text-emerald-100 hover:text-white hover:bg-emerald-700 transition-all cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-6">
            
            {userProfile ? (
              /* Profile view when LOGGED IN */
              <div>
                {isEditingProfile ? (
                  /* Edit Profile Form */
                  <form onSubmit={handleUpdateProfile} className="space-y-4">
                    <div>
                      <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                        Full Name *
                      </label>
                      <div className="relative rounded-lg shadow-2xs">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                          <User className="w-4 h-4" />
                        </div>
                        <input
                          type="text"
                          required
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="E.g., Sok Dara"
                          className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                        Phone Number
                      </label>
                      <div className="relative rounded-lg shadow-2xs">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                          <Phone className="w-4 h-4" />
                        </div>
                        <input
                          type="tel"
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          placeholder="+855 12 345 678"
                          className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                        Delivery Address
                      </label>
                      <div className="relative rounded-lg shadow-2xs">
                        <div className="absolute inset-y-0 left-0 pl-3 pt-3 flex items-start pointer-events-none text-gray-400">
                          <MapPin className="w-4 h-4" />
                        </div>
                        <textarea
                          rows={2}
                          value={editAddress}
                          onChange={(e) => setEditAddress(e.target.value)}
                          placeholder="Phnom Penh, Cambodia"
                          className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                        />
                      </div>
                    </div>

                    <div className="flex space-x-3 pt-3">
                      <button
                        type="button"
                        onClick={() => setIsEditingProfile(false)}
                        className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-semibold transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={loading}
                        className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-all shadow-xs"
                      >
                        {loading ? 'Saving...' : 'Save Changes'}
                      </button>
                    </div>
                  </form>
                ) : (
                  /* Read Profile Details */
                  <div className="space-y-5">
                    <div className="flex items-center space-x-4 bg-gray-50 p-4 rounded-xl border border-gray-100">
                      <div className="h-14 w-14 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xl font-bold font-sans">
                        {userProfile.displayName ? userProfile.displayName.charAt(0).toUpperCase() : 'U'}
                      </div>
                      <div>
                        <h4 className="text-base font-bold text-gray-900 font-sans">{userProfile.displayName}</h4>
                        <p className="text-xs text-gray-500">{userProfile.email}</p>
                        <span className={`inline-block mt-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider ${
                          userProfile.role === 'admin' 
                            ? 'bg-amber-100 text-amber-800 border border-amber-200' 
                            : 'bg-blue-100 text-blue-800 border border-blue-200'
                        }`}>
                          {userProfile.role === 'admin' ? '🛡️ Admin Account' : '🛒 Buyer Profile'}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-3.5 text-sm text-gray-600 font-sans">
                      <div className="flex items-center space-x-2.5">
                        <Phone className="w-4 h-4 text-gray-400" />
                        <span>{userProfile.phone || <em className="text-gray-400">No phone provided</em>}</span>
                      </div>
                      <div className="flex items-start space-x-2.5">
                        <MapPin className="w-4 h-4 text-gray-400 mt-0.5" />
                        <span className="flex-1 text-xs leading-relaxed">
                          {userProfile.address || <em className="text-gray-400">No delivery address configured</em>}
                        </span>
                      </div>
                    </div>

                    <div className="flex space-x-3 pt-4 border-t border-gray-100">
                      <button
                        onClick={() => {
                          setEditName(userProfile.displayName || '');
                          setEditPhone(userProfile.phone || '');
                          setEditAddress(userProfile.address || '');
                          setIsEditingProfile(true);
                        }}
                        className="flex-1 flex items-center justify-center space-x-1.5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-semibold transition-all cursor-pointer"
                      >
                        <Edit className="w-4 h-4" />
                        <span>Edit Profile</span>
                      </button>
                      <button
                        onClick={handleLogout}
                        className="flex-1 flex items-center justify-center space-x-1.5 py-2.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm font-semibold transition-all cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Auth Form (Login or Signup) when LOGGED OUT */
              <form onSubmit={handleAuthSubmit} className="space-y-4">
                
                {/* Form fields */}
                {!isLogin && (
                  <>
                    <div>
                      <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                        Full Name *
                      </label>
                      <div className="relative rounded-lg shadow-2xs">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                          <User className="w-4 h-4" />
                        </div>
                        <input
                          type="text"
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Sok Dara"
                          className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                          Phone Number
                        </label>
                        <div className="relative rounded-lg shadow-2xs">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                            <Phone className="w-4 h-4" />
                          </div>
                          <input
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="555-0192"
                            className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                          Account Type *
                        </label>
                        <div className="relative rounded-lg shadow-2xs">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                            <Shield className="w-4 h-4" />
                          </div>
                          <select
                            value={role}
                            onChange={(e) => setRole(e.target.value as 'buyer' | 'admin')}
                            className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900 font-sans"
                          >
                            <option value="buyer">Buyer (Customer)</option>
                            <option value="admin">Admin (Manager)</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                        Delivery Address
                      </label>
                      <div className="relative rounded-lg shadow-2xs">
                        <div className="absolute inset-y-0 left-0 pl-3 pt-3 flex items-start pointer-events-none text-gray-400">
                          <MapPin className="w-4 h-4" />
                        </div>
                        <textarea
                          rows={2}
                          value={address}
                          onChange={(e) => setAddress(e.target.value)}
                          placeholder="123 Main St, Springfield"
                          className="block w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                    Email Address *
                  </label>
                  <div className="relative rounded-lg shadow-2xs">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                      <Mail className="w-4 h-4" />
                    </div>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-mono font-semibold text-gray-500 uppercase mb-1.5">
                    Password *
                  </label>
                  <div className="relative rounded-lg shadow-2xs">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="block w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-gray-900"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full mt-2 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold shadow-xs transition-all flex items-center justify-center space-x-1.5"
                >
                  <span>{loading ? 'Authenticating...' : isLogin ? 'Sign In' : 'Create Account'}</span>
                </button>

                <div className="pt-3.5 border-t border-gray-100 text-center">
                  <button
                    type="button"
                    onClick={() => setIsLogin(!isLogin)}
                    className="text-xs text-emerald-600 hover:text-emerald-700 font-medium font-sans"
                  >
                    {isLogin 
                      ? "Don't have an account? Sign Up" 
                      : "Already have an account? Sign In"
                    }
                  </button>
                </div>
              </form>
            )}

          </div>

        </div>
      </div>
    </div>
  );
}
